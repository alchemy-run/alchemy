import { domainCertificate, isRoute53Dns } from "@alchemy.run/aws/CustomDomain";
import * as EC2 from "@alchemy.run/aws/EC2";
import * as ECS from "@alchemy.run/aws/ECS";
import * as ELBv2 from "@alchemy.run/aws/ELBv2";
import * as RDS from "@alchemy.run/aws/RDS";
import { CurrentRegion } from "@alchemy.run/aws/Region";
import { resolveHostedZoneId } from "@alchemy.run/aws/Route53/HostedZoneLookup";
import * as S3 from "@alchemy.run/aws/S3";
import * as SSM from "@alchemy.run/aws/SSM";
import type { DnsConfig } from "alchemy/DNS/Adapter";
import type { Input } from "alchemy/Input";
import * as Namespace from "alchemy/Namespace";
import { Random } from "alchemy/Random";
import * as Effect from "effect/Effect";
import {
  assertHostTemplate,
  certificateNames,
  type HostTemplate,
  resolveHostTemplate,
  type ResolvedHostTemplate,
  STORAGE_KEYS,
  type StorageKey,
} from "../internal/selfhosted.ts";

export type DatabaseEngine = "postgres" | "mysql";

export interface CreatedDatabase {
  /** Database engine. Postgres runs version 17 and MySQL 8.0, which Convex tests. */
  engine: DatabaseEngine;
  /** RDS instance class, such as `db.t4g.medium`. */
  instanceClass: string;
  /** Storage in GiB. */
  storage: number;
}

export interface PlatformProps {
  /** The domain stages live under. Covers `*.<domain>`, so stage hosts stay flat. */
  domain: string;
  /**
   * How stage hosts are named. `{stage}`, `{app}` and `{domain}` are filled in,
   * and the certificate gets a wildcard for each template, so a new stage never
   * waits for one. Put `{app}` in the templates to share the platform between
   * apps. The production backend always takes the bare `cloud.<domain>` and
   * `site.<domain>`. Changing it replaces the certificate, and each stage moves
   * to its new hosts on its next deploy.
   * @default { web: "{stage}.{domain}", cloud: "{stage}.cloud.{domain}", site: "{stage}.site.{domain}" }
   */
  hosts?: HostTemplate;
  /** The Route 53 hosted zone for `domain`. Found from the domain when omitted. */
  hostedZoneId?: Input<string>;
  /**
   * The DNS host for `domain`, such as `Cloudflare.DNS.Adapter()`.
   * @default Route 53
   */
  dns?: DnsConfig;
  /**
   * The database server stages share. Each stage gets its own database and
   * user. Omit it for a platform whose stages all run on SQLite, which needs no
   * RDS and comes up faster.
   */
  db?: CreatedDatabase;
  /**
   * Protect the database from deletion and refuse to delete buckets with
   * objects. Turn it off and deploy before destroying.
   * @default true
   */
  deletionProtection?: boolean;
  /** Tags for the resources that take them. */
  tags?: Record<string, string>;
}

/** What a stage needs from a platform. Plain values, so it can cross stacks. */
export interface PlatformHandle {
  /** The domain stages live under. */
  domain: string;
  /**
   * How stage hosts are named. Absent on a platform deployed before templates,
   * which names them the default way.
   */
  hosts?: ResolvedHostTemplate;
  /** The Route 53 hosted zone for `domain`, when Route 53 is the DNS host. */
  hostedZoneId?: string;
  /** The VPC. */
  vpcId: string;
  /** The private subnet in the database's availability zone. */
  subnetId: string;
  /** The ECS cluster stages run in. */
  clusterArn: string;
  /** The HTTPS listener stages add their rules to. */
  listenerArn: string;
  /** The load balancer's DNS name, for alias records. */
  albDnsName: string;
  /** The load balancer's hosted zone, for alias records. */
  albZoneId: string;
  /** The security group every backend task runs in. */
  backendSecurityGroupId: string;
  /** The five shared buckets. */
  storage: Record<StorageKey, { name: string; arn: string }>;
  /** The shared database server. */
  database?: {
    /** Database engine. */
    engine: DatabaseEngine;
    /** The server's address. */
    host: string;
    /** The server's port. */
    port: number;
    /** The master user. */
    username: string;
    /** The SSM parameter holding the master password. Only its name crosses stacks. */
    passwordParameterName: string;
    /** The in-VPC function that creates stage databases. */
    runnerFunctionName: string;
  };
}

type Inputs<T> = {
  [K in keyof T]: NonNullable<T[K]> extends string | number ? Input<T[K]> : Inputs<T[K]>;
};

/** A platform inside a stack, where its values are Outputs until it deploys. */
export type PlatformInputs = Inputs<PlatformHandle>;

const MASTER_USERNAME = "convex_admin";

const ENGINE = {
  postgres: { version: "17", port: 5432 },
  mysql: { version: "8.0", port: 3306 },
} as const;

const BUCKET_IDS: Record<StorageKey, string> = {
  files: "FilesBucket",
  modules: "ModulesBucket",
  exports: "ExportsBucket",
  snapshotImports: "SnapshotImportsBucket",
  search: "SearchBucket",
};

export interface InfrastructureProps {
  certificate: { domainName: string; subjectAlternativeNames?: string[] };
  domain: string;
  /** Set on a shared platform, whose stages name their hosts from it. */
  hosts?: ResolvedHostTemplate;
  hostedZoneId?: Input<string>;
  dns?: DnsConfig;
  db?: CreatedDatabase;
  /** Set for a backend that owns its database, which RDS creates up front. */
  dbName?: string;
  /** Creates the in-VPC runner, which only a shared database needs. */
  shared: boolean;
  deletionProtection: boolean;
  tags?: Record<string, string>;
}

/** Everything that isn't per stage. `Platform` and an owning `Backend` both use it. */
export const Infrastructure = Effect.fn(function* (props: InfrastructureProps) {
  const { tags } = props;
  const network = yield* EC2.Network("Network", {
    cidrBlock: "10.0.0.0/16",
    availabilityZones: 2,
    nat: "single",
    gatewayEndpoints: ["s3"],
    tags,
  });
  const subnetId = network.privateSubnetIds[0]!;
  const availabilityZone = network.availabilityZones[0]!;

  const albSecurityGroup = yield* EC2.SecurityGroup("LoadBalancerSecurityGroup", {
    vpcId: network.vpcId,
    description: "Convex load balancer",
    ingress: [
      { ipProtocol: "tcp", fromPort: 80, toPort: 80, cidrIpv4: "0.0.0.0/0" },
      { ipProtocol: "tcp", fromPort: 443, toPort: 443, cidrIpv4: "0.0.0.0/0" },
    ],
    egress: [{ ipProtocol: "-1", cidrIpv4: "0.0.0.0/0" }],
    tags,
  });
  const backendSecurityGroup = yield* EC2.SecurityGroup("BackendSecurityGroup", {
    vpcId: network.vpcId,
    description: "Convex backend, reachable from the load balancer only",
    ingress: [
      {
        ipProtocol: "tcp",
        fromPort: 3210,
        toPort: 3211,
        referencedGroupId: albSecurityGroup.groupId,
      },
    ],
    egress: [{ ipProtocol: "-1", cidrIpv4: "0.0.0.0/0" }],
    tags,
  });

  const cluster = yield* ECS.Cluster("Cluster", { tags });

  const hostedZoneId = isRoute53Dns(props.dns)
    ? (props.hostedZoneId ??
      (yield* resolveHostedZoneId(undefined, props.domain).pipe(Effect.orDie)))
    : undefined;
  const { certificateArn } = yield* domainCertificate(
    "Certificate",
    {
      ...props.certificate,
      // ACM defaults to us-east-1, for CloudFront. An ALB needs its own region.
      region: yield* CurrentRegion,
      validationMethod: "DNS",
      ...(hostedZoneId === undefined ? {} : { hostedZoneId: hostedZoneId as never }),
      tags,
    },
    props.dns,
  );
  const loadBalancer = yield* ELBv2.LoadBalancer("LoadBalancer", {
    scheme: "internet-facing",
    type: "application",
    subnets: network.publicSubnetIds,
    securityGroups: [albSecurityGroup.groupId],
    // Under this, an idle websocket gets cut.
    attributes: { "idle_timeout.timeout_seconds": "300" },
    tags,
  });
  yield* ELBv2.Listener("HttpListener", {
    loadBalancerArn: loadBalancer.loadBalancerArn,
    port: 80,
    protocol: "HTTP",
    defaultActions: [{ type: "redirect", protocol: "HTTPS", port: "443", statusCode: "HTTP_301" }],
  });
  const listener = yield* ELBv2.Listener("HttpsListener", {
    loadBalancerArn: loadBalancer.loadBalancerArn,
    port: 443,
    protocol: "HTTPS",
    certificateArn,
    sslPolicy: "ELBSecurityPolicy-TLS13-1-2-2021-06",
    defaultActions: [
      {
        type: "fixedResponse",
        statusCode: "404",
        contentType: "text/plain",
        messageBody: "Not found",
      },
    ],
  });

  const storage = {} as PlatformInputs["storage"];
  for (const key of STORAGE_KEYS) {
    const bucket = yield* S3.Bucket(BUCKET_IDS[key], {
      forceDestroy: !props.deletionProtection,
      tags,
    });
    storage[key] = { name: bucket.bucketName, arn: bucket.bucketArn };
  }

  const handle: PlatformInputs = {
    domain: props.domain,
    ...(props.hosts === undefined ? {} : { hosts: props.hosts }),
    hostedZoneId,
    vpcId: network.vpcId,
    subnetId,
    clusterArn: cluster.clusterArn,
    listenerArn: listener.listenerArn,
    albDnsName: loadBalancer.dnsName,
    albZoneId: loadBalancer.canonicalHostedZoneId,
    backendSecurityGroupId: backendSecurityGroup.groupId,
    storage,
  };
  if (props.db === undefined) return { handle, password: undefined };

  const engine = ENGINE[props.db.engine];
  const runnerSecurityGroup = props.shared
    ? yield* EC2.SecurityGroup("RunnerSecurityGroup", {
        vpcId: network.vpcId,
        description: "Creates stage databases",
        egress: [{ ipProtocol: "-1", cidrIpv4: "0.0.0.0/0" }],
        tags,
      })
    : undefined;
  const databaseSecurityGroup = yield* EC2.SecurityGroup("DatabaseSecurityGroup", {
    vpcId: network.vpcId,
    description: "Convex database, reachable from the backend only",
    ingress: [
      {
        ipProtocol: "tcp",
        fromPort: engine.port,
        toPort: engine.port,
        referencedGroupId: backendSecurityGroup.groupId,
      },
      ...(runnerSecurityGroup === undefined
        ? []
        : [
            {
              ipProtocol: "tcp",
              fromPort: engine.port,
              toPort: engine.port,
              referencedGroupId: runnerSecurityGroup.groupId,
            },
          ]),
    ],
    tags,
  });
  const subnetGroup = yield* RDS.DBSubnetGroup("DatabaseSubnets", {
    description: "Convex database",
    subnetIds: network.privateSubnetIds,
    tags,
  });
  // 32 hex characters, because RDS caps a MySQL master password at 41.
  const password = yield* Random("DatabasePassword", { bytes: 16 });
  const database = yield* RDS.DBInstance("Database", {
    engine: props.db.engine,
    engineVersion: engine.version,
    dbInstanceClass: props.db.instanceClass,
    allocatedStorage: props.db.storage,
    storageType: "gp3",
    storageEncrypted: true,
    masterUsername: MASTER_USERNAME,
    masterUserPassword: password.text,
    dbName: props.dbName,
    dbSubnetGroupName: subnetGroup.dbSubnetGroupName,
    vpcSecurityGroupIds: [databaseSecurityGroup.groupId],
    // Latency between the two hurts query speed.
    availabilityZone,
    publiclyAccessible: false,
    allowMajorVersionUpgrade: false,
    autoMinorVersionUpgrade: false,
    deletionProtection: props.deletionProtection,
    skipFinalSnapshot: !props.deletionProtection,
    tags,
  });
  const host = database.endpointAddress as Input<string>;
  const port = database.endpointPort as Input<number>;

  if (runnerSecurityGroup === undefined) {
    return {
      handle,
      password: password.text,
      owned: { engine: props.db.engine, username: MASTER_USERNAME, host, port },
    };
  }
  const passwordParameter = yield* SSM.Parameter("DatabasePasswordParameter", {
    type: "SecureString",
    value: password.text,
    tags,
  });
  const runner = yield* RDS.MigrationRunner("DatabaseRunner", {
    subnetIds: network.privateSubnetIds,
    securityGroupIds: [runnerSecurityGroup.groupId],
  });
  return {
    handle: {
      ...handle,
      database: {
        engine: props.db.engine,
        host,
        port,
        username: MASTER_USERNAME,
        passwordParameterName: passwordParameter.parameterName,
        runnerFunctionName: runner.functionName,
      },
    } satisfies PlatformInputs,
    password: undefined,
  };
});

/**
 * Infrastructure stages share in one AWS account: the network, ECS cluster, load
 * balancer with a wildcard certificate, five buckets, and a database server
 * unless every stage runs on SQLite.
 * Deploy it once per account, from its own stack, and pass it to each
 * `Convex.Backend`.
 *
 * :::caution
 * By default a platform serves the stages of one app. Hosts come from the stage
 * name alone, so a second app's `alice` stage would claim `alice.cloud.<domain>`
 * too: traffic would reach only one of them, and destroying either would delete
 * the other's DNS records. Give each app its own platform, or put `{app}` in
 * the host template (see below).
 * :::
 *
 * ### Two accounts
 * **Example:** One platform per account
 * ```typescript
 * // stacks/platform.ts, deployed once to production and once to development
 * const isProd = stage === "prod";
 * const convex = yield* Convex.Platform("Convex", {
 *   domain: isProd ? "example.com" : "previews.example.com",
 *   // Previews run on SQLite, so the development platform needs no database.
 *   db: isProd ? { engine: "postgres", instanceClass: "db.t4g.medium", storage: 100 } : undefined,
 * });
 * return { convex };
 * ```
 *
 * ### Naming stage hosts
 * A stage `alice` gets `alice.cloud.<domain>` and `alice.site.<domain>` unless
 * `hosts` says otherwise. `{stage}` and `{app}` go in the first label, which the
 * platform's wildcard certificate covers, so a new stage never waits for a
 * certificate.
 *
 * **Example:** Flat hosts under one wildcard
 * ```typescript
 * const convex = yield* Convex.Platform("Convex", {
 *   domain: "preview.example.com",
 *   hosts: { cloud: "{stage}-api.{domain}", site: "{stage}-site.{domain}" },
 * });
 * // stage pippo: pippo-api.preview.example.com, pippo-site.preview.example.com
 * ```
 *
 * **Example:** Two apps on one platform
 * ```typescript
 * const convex = yield* Convex.Platform("Convex", {
 *   domain: "preview.example.com",
 *   hosts: { cloud: "{stage}-{app}-api.{domain}", site: "{stage}-{app}-site.{domain}" },
 * });
 * // in each app's stack
 * const backend = yield* Convex.Backend("Backend", { platform: convex, image, app: "shop" });
 * ```
 *
 * ### Safety
 * `deletionProtection` is on by default, so destroying a platform fails until
 * you set it to `false` and deploy.
 *
 * @see https://github.com/convex/convex-backend/tree/main/self-hosted
 *
 * @resource
 * @product Self-hosted
 */
export const Platform = (id: string, props: PlatformProps) =>
  Namespace.push(
    id,
    Effect.gen(function* () {
      yield* assertHostTemplate(props.hosts).pipe(Effect.orDie);
      const { handle } = yield* Infrastructure({
        certificate: certificateNames(props.domain, props.hosts),
        domain: props.domain,
        hosts: resolveHostTemplate(props.hosts),
        hostedZoneId: props.hostedZoneId,
        dns: props.dns,
        db: props.db,
        shared: true,
        deletionProtection: props.deletionProtection ?? true,
        tags: props.tags,
      });
      return handle;
    }),
  );
