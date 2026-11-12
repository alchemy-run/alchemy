import { resolveDomainDns } from "@alchemy.run/aws/CustomDomain";
import * as ECS from "@alchemy.run/aws/ECS";
import * as ELBv2 from "@alchemy.run/aws/ELBv2";
import * as IAM from "@alchemy.run/aws/IAM";
import { CurrentRegion } from "@alchemy.run/aws/Region";
import * as SSM from "@alchemy.run/aws/SSM";
import type { DnsConfig } from "alchemy/DNS/Adapter";
import type { Input } from "alchemy/Input";
import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import { Random } from "alchemy/Random";
import { Stack } from "alchemy/Stack";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  assertNoReservedEnv,
  assertPinnedImage,
  assertStageHosts,
  hostLabelOf,
  backendEnv,
  type BackendEnv,
  databaseName,
  databaseUrl,
  instanceNameOf,
  listenerPriority,
  SqliteInProduction,
  stageHosts,
  STORAGE_ENV,
  STORAGE_KEYS,
  storagePrefixPattern,
} from "../internal/selfhosted.ts";
import { AdminKey } from "./AdminKey.ts";
import {
  type CreatedDatabase,
  type DatabaseEngine,
  Infrastructure,
  type PlatformHandle,
  type PlatformInputs,
} from "./Platform.ts";
import { StageDatabase } from "./StageDatabase.ts";
import { StageStorage } from "./StageStorage.ts";

const CONTAINER = "backend";
const RDS_CA_PATH = "/tmp/rds-ca.pem";
/** The image has no RDS CA, and Convex verifies whatever a server offers. */
const RDS_CA_URL = "https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem";
const CLOUD_PORT = 3210;
const SITE_PORT = 3211;

export type BackendDb =
  | {
      /**
       * SQLite on the task's own disk, for development and tests. The data
       * starts empty whenever a new task does, which includes a deploy that
       * changes the backend. Refused when `production` is true.
       */
      engine: "sqlite";
    }
  | CreatedDatabase
  | {
      /** The engine `url` points at. */
      engine: DatabaseEngine;
      /**
       * An existing server, as `postgres://user:password@host:port`. A path or
       * query string is dropped, because the backend adds its own. The database
       * must already exist and be named after `instanceName`, with `-` changed
       * to `_`.
       */
      url: Redacted.Redacted<string>;
      /**
       * Require TLS, verified against the certificates in the image. Turn this
       * off for a server on your own network that offers no TLS, or one whose
       * CA isn't in the image. Traffic then isn't encrypted.
       * @default true
       */
      requireSsl?: boolean;
    };

interface BackendCommonProps {
  /**
   * The backend image, pinned by digest. Required, because Convex migrations only
   * go forward, so an Alchemy update must never change your image.
   */
  image: string;
  /**
   * Copy the image into an ECR repository of the stage's own before running it.
   * Off, the task pulls `image` from its registry through the platform's NAT
   * gateway, so a deploy pushes nothing from your machine. Turn it on when the
   * tasks can't reach the registry, or to stop depending on it at each task
   * start. On, the deploy needs Docker, which pulls the image and pushes it.
   * @default false
   */
  mirror?: boolean;
  /** Environment for the backend. Names the resource sets are rejected. */
  env?: BackendEnv;
  /**
   * CPU units, where 1024 is one vCPU.
   * @default 1024
   */
  cpu?: number;
  /**
   * Memory in MiB.
   * @default 2048
   */
  memory?: number;
  /**
   * The backend's `INSTANCE_NAME`, which names its data. Changing it fails.
   * @default derived from the stack and stage
   */
  instanceName?: string;
  /**
   * Whether this is the production backend. It refuses SQLite and, on a
   * platform, protects its database and takes the platform's bare hosts
   * (`cloud.<domain>`).
   * @default true on the `prod` stage, otherwise false
   */
  production?: boolean;
  /** How long to keep logs. */
  logRetention?: Duration.Input;
  /** Tags for the resources that take them. */
  tags?: Record<string, string>;
}

export interface OwnedBackendProps extends BackendCommonProps {
  /** The two public hosts. */
  domain: {
    /** Serves the Convex API on port 3210. */
    cloud: string;
    /** Serves HTTP actions on port 3211. */
    site: string;
    /** The Route 53 hosted zone. Found from `cloud` when omitted. */
    hostedZoneId?: Input<string>;
    /**
     * The DNS host, such as `Cloudflare.DNS.Adapter()`.
     * @default Route 53
     */
    dns?: DnsConfig;
  };
  /** Where the backend stores its data. */
  db: BackendDb;
  /**
   * Protect a created database from deletion and refuse to delete buckets with
   * objects. Turn it off and deploy before destroying.
   * @default true
   */
  deletionProtection?: boolean;
  platform?: never;
}

export interface PlatformBackendProps extends BackendCommonProps {
  /** A shared `Convex.Platform`. The backend gets its own database, user and host names. */
  platform: PlatformHandle | Output.ToOutput<PlatformHandle>;
  /**
   * The DNS host for this stage's records, such as `Cloudflare.DNS.Adapter()`.
   * Pass the one the platform uses.
   * @default Route 53
   */
  dns?: DnsConfig;
  domain?: never;
  /**
   * `{ engine: "sqlite" }` keeps this stage's data in a file on the task's own
   * disk instead of the platform's database server. It needs no RDS and no
   * volume, so a preview comes up fastest; the data starts empty whenever a new
   * task does. Production refuses it.
   * @default a database on the platform's server
   */
  db?: { engine: "sqlite" };
  /**
   * Refuse to destroy this stage's database and bucket prefix. Turn it off and
   * deploy before destroying.
   * @default `production`
   */
  deletionProtection?: boolean;
  /**
   * The first of the two listener rule priorities this stage takes on the
   * platform's listener (it uses this and the next). Derived from the instance
   * name; set it only if a deploy fails with `ListenerRulePriorityInUse`.
   * @default derived from the instance name
   */
  listenerPriority?: number;
}

export type BackendProps = OwnedBackendProps | PlatformBackendProps;

/** The URL each database engine's backend reads. */
const URL_ENV = { postgres: "POSTGRES_URL", mysql: "MYSQL_URL" } as const;

const asUrl = (
  engine: DatabaseEngine,
  username: string,
  password: Input<Redacted.Redacted<string>>,
  host: Input<string>,
  port: Input<number>,
) =>
  Output.map(
    Output.all(password as never, host as never, port as never),
    ([secret, address, number]: [Redacted.Redacted<string>, string, number]) =>
      Redacted.make(`${engine}://${username}:${Redacted.value(secret)}@${address}:${number}`),
  );

/** A platform's values are Outputs from another stack, and plain in the same one. */
const hostOn = (
  domain: Input<string>,
  label: string,
  production: boolean,
  host: "cloud" | "site",
) =>
  Output.map(
    Output.asOutput(domain as string) as Output.Output<string, never>,
    (name: string) => stageHosts(name, label, production)[host],
  );

/**
 * Self-hosted Convex on AWS: one Fargate task behind a load balancer, with
 * buckets, TLS and DNS. On its own it owns all of that. Given a shared
 * `Convex.Platform`, it adds only what's per stage.
 *
 * @see https://github.com/convex/convex-backend/tree/main/self-hosted
 *
 * ### Requirements
 * Deploying needs no Docker: the admin key is computed on the deploying
 * machine, and the task pulls the image from its registry through the
 * platform's NAT gateway, unless `mirror` copies it into ECR first. The
 * domain's hosted zone must be in the same account.
 *
 * ### Running on its own
 * **Example:** Postgres and buckets, created by the resource
 * ```typescript
 * const backend = yield* Convex.Backend("Backend", {
 *   image: "ghcr.io/convex/convex-backend:latest@sha256:<digest>",
 *   domain: { cloud: "cloud.example.com", site: "site.example.com" },
 *   db: { engine: "postgres", instanceClass: "db.t4g.medium", storage: 50 },
 * });
 * yield* Convex.Functions("Functions", { backend, rootDir: "." });
 * ```
 *
 * ### Choosing a database
 * **Example:** A server you already run
 * ```typescript
 * const backend = yield* Convex.Backend("Backend", {
 *   image,
 *   domain,
 *   db: { engine: "mysql", url: yield* Config.Redacted("DATABASE_URL") },
 * });
 * ```
 *
 * **Example:** A file on the task's disk, for development
 * ```typescript
 * const backend = yield* Convex.Backend("Backend", {
 *   image,
 *   domain,
 *   db: { engine: "sqlite" },
 * });
 * ```
 *
 * ### Using another DNS host
 * **Example:** Records on Cloudflare
 * ```typescript
 * const backend = yield* Convex.Backend("Backend", {
 *   image,
 *   db,
 *   domain: {
 *     cloud: "cloud.example.com",
 *     site: "site.example.com",
 *     dns: Cloudflare.DNS.Adapter(),
 *   },
 * });
 * ```
 *
 * ### Sharing a platform
 * **Example:** One stage on a shared `Convex.Platform`
 * ```typescript
 * const { convex } = yield* Platform;
 * const backend = yield* Convex.Backend("Backend", { platform: convex, image });
 * ```
 *
 * A stage named `alice` gets `alice.cloud.<domain>` and `alice.site.<domain>`.
 * The production backend gets `cloud.<domain>` and `site.<domain>`, a protected
 * database, and no SQLite. That's the `prod` stage unless you say otherwise.
 *
 * **Example:** A production stage with another name
 * ```typescript
 * const { stage } = yield* Stack;
 * const backend = yield* Convex.Backend("Backend", {
 *   platform: convex,
 *   image,
 *   production: stage === "production",
 * });
 * ```
 *
 * ### Removing a Backend
 * :::caution
 * `deletionProtection` keeps a created database and buckets with objects, not
 * the running backend. A refused destroy has already removed the service and
 * hosts. Deploying again restores them with a new instance secret and admin
 * key. To remove the data, set it to `false`, deploy, then destroy.
 * :::
 *
 * **Example:** Allow destroy
 * ```typescript
 * const backend = yield* Convex.Backend("Backend", {
 *   image,
 *   domain,
 *   db,
 *   deletionProtection: false,
 * });
 * ```
 *
 * ### Building a site in parallel
 * `backend.url` resolves once the backend is running, so whatever reads it
 * waits for the service. A site only needs the address, which
 * `backend.endpoints` has from the start, so it builds while the backend
 * comes up.
 *
 * **Example:** A website that doesn't wait for the backend
 * ```typescript
 * const website = yield* AWS.Website.TanStackStart("Website", {
 *   env: { CONVEX_URL: backend.endpoints.url },
 * });
 * ```
 *
 * ### Safety
 * The backend holds an exclusive lease on its database, so there is one task
 * and a rollout stops the old one first. Expect a short outage on each deploy.
 * A changed instance name fails the plan, because it would point the backend at
 * a new, empty database.
 *
 * @resource
 * @product Self-hosted
 */
export const Backend = (id: string, props: BackendProps) =>
  Namespace.push(
    id,
    Effect.gen(function* () {
      const { name: stackName, stage } = yield* Stack;
      const env = props.env ?? {};
      yield* assertPinnedImage(props.image).pipe(Effect.orDie);
      yield* assertNoReservedEnv(env).pipe(Effect.orDie);
      const production = props.production ?? stage === "prod";
      if (props.db?.engine === "sqlite" && production) {
        return yield* Effect.die(
          new SqliteInProduction({
            message:
              "SQLite is for development only. Use postgres or mysql for a production backend.",
          }),
        );
      }

      const instanceName = props.instanceName ?? instanceNameOf(stackName, stage);
      const database = databaseName(instanceName);
      const cpu = props.cpu ?? 1024;
      const memory = props.memory ?? 2048;
      const tags = props.tags;

      // Owned mode builds what a platform would have provided, once for this backend.
      const created =
        props.platform === undefined
          ? yield* Infrastructure({
              certificate: {
                domainName: props.domain.cloud,
                subjectAlternativeNames: [props.domain.site],
              },
              domain: props.domain.cloud,
              hostedZoneId: props.domain.hostedZoneId,
              dns: props.domain.dns,
              db: props.db.engine === "sqlite" || "url" in props.db ? undefined : props.db,
              dbName: database,
              shared: false,
              deletionProtection: props.deletionProtection ?? true,
              tags,
            })
          : undefined;
      const platform = (props.platform ?? created!.handle) as PlatformInputs;

      const label = hostLabelOf(stage);
      if (props.platform !== undefined && !production) {
        yield* assertStageHosts(label).pipe(Effect.orDie);
      }
      const hosts =
        props.platform === undefined
          ? { cloud: props.domain.cloud, site: props.domain.site }
          : {
              cloud: hostOn(props.platform.domain, label, production, "cloud"),
              site: hostOn(props.platform.domain, label, production, "site"),
            };
      const cloudUrl = Output.interpolate`https://${hosts.cloud}`;
      const siteUrl = Output.interpolate`https://${hosts.site}`;

      // Generated once. A new secret invalidates every admin key.
      const secret = yield* Random("InstanceSecret");
      const instanceSecret = yield* SSM.Parameter("InstanceSecretParameter", {
        type: "SecureString",
        value: secret.text,
        tags,
      });
      // The service reads the name from here, so a rename fails before it changes.
      const adminKey = yield* AdminKey("AdminKey", {
        instanceName,
        instanceSecret: secret.text,
      });

      // Where the data lives.
      const url = props.db !== undefined && "url" in props.db ? props.db : undefined;
      const onSqlite = props.db?.engine === "sqlite";
      const onRds = (props.platform !== undefined && !onSqlite) || created?.owned !== undefined;
      const databaseEnv: Record<string, string> = {
        ...(url?.requireSsl === false ? { DO_NOT_REQUIRE_SSL: "1" } : {}),
        ...(onRds ? { PG_CA_FILE: RDS_CA_PATH, MYSQL_CA_FILE: RDS_CA_PATH } : {}),
      };
      let secrets: Input<Record<string, string>> = {
        INSTANCE_SECRET: instanceSecret.parameterArn,
      } as never;
      if (props.platform !== undefined && !onSqlite) {
        const password = yield* Random("DatabasePassword", { bytes: 16 });
        const stageDatabase = yield* StageDatabase("Database", {
          platform: props.platform as never,
          instanceName,
          password: password.text,
          deletionProtection: props.deletionProtection ?? production,
        });
        const parameter = yield* SSM.Parameter("DatabaseUrlParameter", {
          type: "SecureString",
          value: stageDatabase.url,
          tags,
        });
        // From another stack the engine is an Output, so the name resolves with it.
        secrets = Output.map(
          Output.all(
            instanceSecret.parameterArn as never,
            parameter.parameterArn as never,
            Output.asOutput(props.platform.database!.engine) as never,
          ),
          ([instance, database, engine]: [string, string, DatabaseEngine]) => ({
            INSTANCE_SECRET: instance,
            [URL_ENV[engine]]: database,
          }),
        ) as never;
      } else if (onSqlite) {
        if (props.platform !== undefined) {
          // The stage database cleans up the bucket prefix; SQLite has none.
          yield* StageStorage("Storage", {
            storage: platform.storage as never,
            instanceName,
          });
        }
        // The SQLite file lives on the task's own disk, so it needs no volume
        // and starts empty whenever a new task does.
      } else {
        const value =
          url !== undefined
            ? yield* databaseUrl(url.engine, url.url, url.requireSsl !== false).pipe(Effect.orDie)
            : asUrl(
                created!.owned!.engine,
                created!.owned!.username,
                created!.password!,
                created!.owned!.host,
                created!.owned!.port,
              );
        const parameter = yield* SSM.Parameter("DatabaseUrlParameter", {
          type: "SecureString",
          value: value as Redacted.Redacted<string>,
          tags,
        });
        secrets = {
          INSTANCE_SECRET: instanceSecret.parameterArn,
          // Only an owned backend on a server reaches here: a url, or one it created.
          [URL_ENV[url?.engine ?? created!.owned!.engine]]: parameter.parameterArn,
        } as never;
      }

      // Traffic. These stay in this stage on a shared listener.
      const cloudTarget = yield* ELBv2.TargetGroup("CloudTarget", {
        vpcId: platform.vpcId as never,
        port: CLOUD_PORT,
        protocol: "HTTP",
        targetType: "ip",
        healthCheckPath: "/version",
        healthCheckInterval: "10 seconds",
        attributes: { "deregistration_delay.timeout_seconds": "10" },
        tags,
      });
      const siteTarget = yield* ELBv2.TargetGroup("SiteTarget", {
        vpcId: platform.vpcId as never,
        port: SITE_PORT,
        protocol: "HTTP",
        targetType: "ip",
        healthCheckPath: "/",
        healthCheckInterval: "10 seconds",
        // The site port returns 404 until an app defines HTTP routes.
        matcher: { HttpCode: "200-499" },
        attributes: { "deregistration_delay.timeout_seconds": "10" },
        tags,
      });
      const priority =
        (props.platform !== undefined ? props.listenerPriority : undefined) ??
        listenerPriority(instanceName);
      yield* ELBv2.ListenerRule("CloudRule", {
        listenerArn: platform.listenerArn as never,
        priority,
        conditions: [{ hostHeader: { values: [hosts.cloud as never] } }],
        actions: [
          { type: "forward", targetGroups: [{ targetGroupArn: cloudTarget.targetGroupArn }] },
        ],
      });
      yield* ELBv2.ListenerRule("SiteRule", {
        listenerArn: platform.listenerArn as never,
        priority: priority + 1,
        conditions: [{ hostHeader: { values: [hosts.site as never] } }],
        actions: [
          { type: "forward", targetGroups: [{ targetGroupArn: siteTarget.targetGroupArn }] },
        ],
      });
      const dns = yield* resolveDomainDns(
        props.platform === undefined ? props.domain.dns : props.dns,
        platform.hostedZoneId as Input<string> | undefined,
      );
      for (const [recordId, name] of [
        ["CloudRecord", hosts.cloud],
        ["SiteRecord", hosts.site],
      ] as const) {
        yield* dns.alias(recordId, {
          name: name as never,
          target: {
            hostname: platform.albDnsName as never,
            route53Alias: {
              hostedZoneId: platform.albZoneId as never,
              evaluateTargetHealth: true,
            },
          },
        });
      }

      // Storage. On a platform, only this stage's prefix of the shared buckets.
      const objects = STORAGE_KEYS.map((key) =>
        props.platform === undefined
          ? Output.interpolate`${platform.storage[key].arn}/*`
          : Output.interpolate`${platform.storage[key].arn}/${storagePrefixPattern(instanceName)}`,
      );
      const buckets = STORAGE_KEYS.map((key) => platform.storage[key].arn);
      const storagePolicy = yield* IAM.Policy("StoragePolicy", {
        policyDocument: {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: [
                "s3:GetObject",
                "s3:PutObject",
                "s3:DeleteObject",
                "s3:AbortMultipartUpload",
                "s3:ListMultipartUploadParts",
              ],
              Resource: objects as never,
            },
            {
              Effect: "Allow",
              Action: ["s3:GetBucketLocation"],
              Resource: buckets as never,
            },
            {
              Effect: "Allow",
              Action: ["s3:ListBucket"],
              Resource: buckets as never,
              ...(props.platform === undefined
                ? {}
                : {
                    // Not IfExists: a list with no prefix would see every stage.
                    Condition: { StringLike: { "s3:prefix": storagePrefixPattern(instanceName) } },
                  }),
            },
          ],
        },
      });

      const service = yield* ECS.Service("Service", {
        cluster: { clusterArn: platform.clusterArn as never },
        image: props.image,
        mirror: props.mirror ?? false,
        cpu,
        memory,
        port: CLOUD_PORT,
        desiredCount: 1,
        // Fargate on Graviton, and the image is published for it.
        runtimePlatform: { cpuArchitecture: "ARM64", operatingSystemFamily: "LINUX" },
        subnets: [platform.subnetId as never],
        securityGroups: [platform.backendSecurityGroupId as never],
        assignPublicIp: false,
        loadBalancers: [
          {
            targetGroupArn: cloudTarget.targetGroupArn,
            containerName: CONTAINER,
            containerPort: CLOUD_PORT,
          },
          {
            targetGroupArn: siteTarget.targetGroupArn,
            containerName: CONTAINER,
            containerPort: SITE_PORT,
          },
        ],
        container: {
          name: CONTAINER,
          ...(onRds
            ? {
                entryPoint: ["sh", "-c"],
                command: [
                  `curl -fsS --retry 5 -o ${RDS_CA_PATH} ${RDS_CA_URL} && exec ./run_backend.sh`,
                ],
              }
            : {}),
          portMappings: [
            { containerPort: CLOUD_PORT, protocol: "tcp" },
            { containerPort: SITE_PORT, protocol: "tcp" },
          ],
        },
        // One task, always: the backend holds an exclusive lease on its database.
        deploymentConfiguration: { minimumHealthyPercent: 0, maximumPercent: 100 },
        healthCheckGracePeriod: "120 seconds",
        healthCheck: {
          command: ["CMD-SHELL", `curl -f http://localhost:${CLOUD_PORT}/version || exit 1`],
          interval: "5 seconds",
          timeout: "4 seconds",
          retries: 3,
          startPeriod: "30 seconds",
        },
        env: {
          ...backendEnv({ size: { cpu, memory }, env }),
          ...databaseEnv,
          INSTANCE_NAME: adminKey.instanceName,
          CONVEX_CLOUD_ORIGIN: cloudUrl,
          CONVEX_SITE_ORIGIN: siteUrl,
          AWS_REGION: yield* CurrentRegion,
          ...Object.fromEntries(
            STORAGE_KEYS.map((key) => [STORAGE_ENV[key], platform.storage[key].name]),
          ),
        },
        secrets: secrets as never,
        taskRoleManagedPolicyArns: [storagePolicy.policyArn],
        logging: { retention: props.logRetention },
        tags,
      });

      // Through the service, so a push waits for a running backend.
      const running = (value: Output.Output<string, any>) =>
        Output.map(
          Output.all(value as never, service.serviceArn as never),
          ([resolved]: [string, string]) => resolved,
        );

      return {
        url: running(cloudUrl),
        siteUrl: running(siteUrl),
        // Known before the backend runs, so a site build can start right away.
        endpoints: { url: cloudUrl, siteUrl },
        // A SQLite backend's data lives with its task, and a new task definition
        // means a new task. Functions pushes again when this changes.
        dataRevision: onSqlite ? service.taskDefinitionArn : undefined,
        adminKey: adminKey.value,
        instanceName,
        databaseName: database,
        service,
      };
    }),
  );
