import * as EC2 from "@alchemy.run/aws/EC2";
import * as ECS from "@alchemy.run/aws/ECS";
import * as ELBv2 from "@alchemy.run/aws/ELBv2";
import * as RDS from "@alchemy.run/aws/RDS";
import * as Route53 from "@alchemy.run/aws/Route53";
import * as S3 from "@alchemy.run/aws/S3";
import * as SSM from "@alchemy.run/aws/SSM";
import * as Convex from "@alchemy.run/convex/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as lambda from "@distilled.cloud/aws/lambda";
import * as ssm from "@distilled.cloud/aws/ssm";
import { OwnedBySomeoneElse } from "alchemy/AdoptPolicy";
import { Random } from "alchemy/Random";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { assertDevAccount } from "./guard.ts";
import { BACKEND_IMAGE, databaseServerGone } from "./support.ts";

// A production backend's behaviour, on real AWS. A platform is built by hand
// with an HTTP listener, so this needs no public domain or certificate, and
// hosts are proved through the Host header.
const { test } = Test.make({ providers: Convex.providers() });

const DOMAIN = "convex-prod-path.alchemy";
const USERNAME = "convex_admin";

const platform = Effect.gen(function* () {
  const network = yield* EC2.Network("Network", {
    cidrBlock: "10.0.0.0/16",
    availabilityZones: 2,
    nat: "single",
    gatewayEndpoints: ["s3"],
  });
  const albGroup = yield* EC2.SecurityGroup("AlbGroup", {
    vpcId: network.vpcId,
    description: "load balancer",
    ingress: [{ ipProtocol: "tcp", fromPort: 80, toPort: 80, cidrIpv4: "0.0.0.0/0" }],
    egress: [{ ipProtocol: "-1", cidrIpv4: "0.0.0.0/0" }],
  });
  const backendGroup = yield* EC2.SecurityGroup("BackendGroup", {
    vpcId: network.vpcId,
    description: "backend",
    ingress: [
      { ipProtocol: "tcp", fromPort: 3210, toPort: 3211, referencedGroupId: albGroup.groupId },
    ],
    egress: [{ ipProtocol: "-1", cidrIpv4: "0.0.0.0/0" }],
  });
  const runnerGroup = yield* EC2.SecurityGroup("RunnerGroup", {
    vpcId: network.vpcId,
    description: "runner",
    egress: [{ ipProtocol: "-1", cidrIpv4: "0.0.0.0/0" }],
  });
  const databaseGroup = yield* EC2.SecurityGroup("DatabaseGroup", {
    vpcId: network.vpcId,
    description: "database",
    ingress: [
      { ipProtocol: "tcp", fromPort: 5432, toPort: 5432, referencedGroupId: backendGroup.groupId },
      { ipProtocol: "tcp", fromPort: 5432, toPort: 5432, referencedGroupId: runnerGroup.groupId },
    ],
  });
  const cluster = yield* ECS.Cluster("Cluster", {});
  const balancer = yield* ELBv2.LoadBalancer("LoadBalancer", {
    scheme: "internet-facing",
    type: "application",
    subnets: network.publicSubnetIds,
    securityGroups: [albGroup.groupId],
  });
  const listener = yield* ELBv2.Listener("Listener", {
    loadBalancerArn: balancer.loadBalancerArn,
    port: 80,
    protocol: "HTTP",
    defaultActions: [{ type: "fixedResponse", statusCode: "404", messageBody: "no host matched" }],
  });
  const zone = yield* Route53.HostedZone("Zone", { name: DOMAIN });
  const buckets = yield* Effect.forEach(
    ["Files", "Modules", "Exports", "Imports", "Search"],
    (id) => S3.Bucket(id, { forceDestroy: true }),
  );
  const subnets = yield* RDS.DBSubnetGroup("Subnets", {
    description: "prod path",
    subnetIds: network.privateSubnetIds,
  });
  const password = yield* Random("MasterPassword", { bytes: 16 });
  const database = yield* RDS.DBInstance("Database", {
    engine: "postgres",
    engineVersion: "17",
    dbInstanceClass: "db.t4g.micro",
    allocatedStorage: 20,
    masterUsername: USERNAME,
    masterUserPassword: password.text,
    dbSubnetGroupName: subnets.dbSubnetGroupName,
    vpcSecurityGroupIds: [databaseGroup.groupId],
    availabilityZone: network.availabilityZones[0]!,
    publiclyAccessible: false,
    deletionProtection: false,
    skipFinalSnapshot: true,
  });
  const parameter = yield* SSM.Parameter("MasterPasswordParameter", {
    type: "SecureString",
    value: password.text,
  });
  const runner = yield* RDS.MigrationRunner("Runner", {
    subnetIds: network.privateSubnetIds,
    securityGroupIds: [runnerGroup.groupId],
  });
  const storage = (index: number) => ({
    name: buckets[index]!.bucketName,
    arn: buckets[index]!.bucketArn,
  });
  return {
    balancerDns: balancer.dnsName,
    handle: {
      domain: DOMAIN,
      hostedZoneId: zone.id,
      vpcId: network.vpcId,
      subnetId: network.privateSubnetIds[0]!,
      clusterArn: cluster.clusterArn,
      listenerArn: listener.listenerArn,
      albDnsName: balancer.dnsName,
      albZoneId: balancer.canonicalHostedZoneId,
      backendSecurityGroupId: backendGroup.groupId,
      storage: {
        files: storage(0),
        modules: storage(1),
        exports: storage(2),
        snapshotImports: storage(3),
        search: storage(4),
      },
      database: {
        engine: "postgres" as const,
        host: database.endpointAddress,
        port: database.endpointPort,
        username: USERNAME,
        passwordParameterName: parameter.parameterName,
        runnerFunctionName: runner.functionName,
      },
    },
  };
});

const app = (backend: { id?: string; deletionProtection?: boolean } | undefined) =>
  Effect.gen(function* () {
    const { handle, balancerDns } = yield* platform;
    const deployed =
      backend === undefined
        ? undefined
        : yield* Convex.Backend(backend.id ?? "Backend", {
            platform: handle as never,
            image: BACKEND_IMAGE,
            instanceName: "prod-path",
            production: true,
            cpu: 512,
            memory: 1024,
            deletionProtection: backend.deletionProtection,
          });
    return { balancerDns, handle, url: deployed?.url };
  });

/** A request through the load balancer, as if `host` had resolved to it. */
const through = (dns: string, host: string, path: string) =>
  HttpClient.HttpClient.pipe(
    Effect.flatMap((http) =>
      http.execute(
        HttpClientRequest.get(`http://${dns}${path}`).pipe(
          HttpClientRequest.setHeader("Host", host),
        ),
      ),
    ),
    Effect.map((response) => response.status),
  );

/** Asks the real server, through the in-VPC runner, whether the database exists. */
const databaseExists = Effect.fn(function* (handle: {
  database: {
    host: string;
    port: number;
    passwordParameterName: string;
    runnerFunctionName: string;
  };
}) {
  const { Parameter } = yield* ssm.getParameter({
    Name: handle.database.passwordParameterName,
    WithDecryption: true,
  });
  const value = Parameter!.Value!;
  const response = yield* lambda.invoke({
    FunctionName: handle.database.runnerFunctionName,
    Payload: JSON.stringify({
      op: "query",
      sql: "SELECT 1 FROM pg_database WHERE datname = 'prod_path'",
      target: {
        dialect: "postgres",
        host: handle.database.host,
        port: handle.database.port,
        database: "postgres",
        username: USERNAME,
        password: Redacted.isRedacted(value) ? Redacted.value(value) : value,
      },
    }),
  });
  const body = yield* response.Payload!.pipe(Stream.decodeText(), Stream.mkString);
  const parsed = JSON.parse(body) as { ok: boolean; rows: unknown[] };
  expect(parsed.ok).toBe(true);
  return parsed.rows.length > 0;
});

test.provider.skipIf(process.env.CONVEX_TEST_AWS !== "1" || process.env.CONVEX_TEST_RDS !== "1")(
  "a production backend uses bare hosts and refuses to drop its database",
  (stack) =>
    Effect.gen(function* () {
      yield* assertDevAccount;
      yield* stack.destroy();

      // A production backend gets cloud.<domain>, and is protected by default.
      const first = yield* stack.deploy(app({}));
      expect(first.url).toBe(`https://cloud.${DOMAIN}`);
      expect(yield* through(first.balancerDns, `cloud.${DOMAIN}`, "/version")).toBe(200);
      expect(yield* databaseExists(first.handle as never)).toBe(true);

      // A renamed backend reaches the same database. It's refused rather than
      // taken over, so the old one's destroy can't drop data the new one uses.
      const renamed = yield* stack.deploy(app({ id: "Api" })).pipe(Effect.result);
      expect(Result.isFailure(renamed)).toBe(true);
      if (Result.isFailure(renamed)) expect(renamed.failure).toBeInstanceOf(OwnedBySomeoneElse);
      expect(yield* databaseExists(first.handle as never)).toBe(true);
      yield* stack.deploy(app({}));

      // Removing the backend from the stack is what would drop the data.
      const refused = yield* stack.deploy(app(undefined)).pipe(Effect.result);
      expect(Result.isFailure(refused)).toBe(true);
      expect(String(Result.isFailure(refused) ? refused.failure : "")).toContain(
        "deletionProtection",
      );
      expect(yield* databaseExists(first.handle as never)).toBe(true);

      // Turning protection off is the way out, and then the data does go.
      yield* stack.deploy(app({ deletionProtection: false }));
      yield* stack.deploy(app(undefined));
      expect(yield* databaseExists(first.handle as never)).toBe(false);

      yield* stack.destroy();
      expect(yield* databaseServerGone(first.handle.database!.host as string)).toBe(true);
    }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.ignore))),
  {
    tags: ["provider:convex", "provider:convex:backend", "provider:aws", "live"],
    timeout: 3_000_000,
  },
);
