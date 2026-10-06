import { fromCredentials } from "@distilled.cloud/aws/Credentials";
import { Region } from "@distilled.cloud/aws/Region";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import { Action } from "@/Action";
import { apply } from "@/Apply";
import { provideFreshArtifactStore } from "@/Artifacts";
import { DBInstance } from "@/AWS/RDS";
import { DBInstanceProvider } from "@/AWS/RDS/DBInstance.ts";
import * as Plan from "@/Plan";
import * as Stack from "@/Stack";
import { Stage } from "@/Stage";
import { InMemoryService, State, type ResourceState } from "@/State";

// ── physical identity changes behind an unchanged identifier ─────────────
//
// A point-in-time restore finished with the rename swap (restore to a
// temporary identifier, rename the original away, rename the restored
// instance to the original identifier) leaves the declared identifier, ARN
// and endpoint as they were, but on a different physical server: a new
// `DbiResourceId`. Nothing in the desired props changed, so the deploy after
// the swap must still notice the new server, publish its attributes, and rerun
// what consumes them. These run the REAL engine and provider against a fake
// RDS control plane, so they need no AWS account.

const TEST_REGION = "us-east-1";
const ACCOUNT = "123456789012";
const IDENTIFIER = "app-db";
const ARN = `arn:aws:rds:${TEST_REGION}:${ACCOUNT}:db:${IDENTIFIER}`;
const STAGE = "dev";

// Built with distilled's own helper so its signer can unwrap the Redacted
// secret (see the same note in S3/Bucket.test.ts).
const testCredentials = fromCredentials(
  {
    accessKeyId: Redacted.make("AKIAIOSFODNN7EXAMPLE"),
    secretAccessKey: Redacted.make("test-secret-key"),
  },
  TEST_REGION,
);

const escapeXml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/**
 * The members of a Query-protocol list parameter, in order: `Name.<Member>.N`, or
 * `Name.<Member>.N.Field` for a list of structures. RDS names each member after
 * its element (`VpcSecurityGroupIds.VpcSecurityGroupId.1`, `Tags.Tag.1.Key`).
 */
const listParam = (params: URLSearchParams, name: string, field?: string) => {
  const pattern = new RegExp(`^${name}\\.[^.]+\\.(\\d+)${field ? `\\.${field}` : ""}$`);
  return [...params.entries()]
    .flatMap(([key, value]) => {
      const match = pattern.exec(key);
      return match ? [[Number(match[1]), value] as const] : [];
    })
    .sort(([a], [b]) => a - b)
    .map(([, value]) => value);
};

interface FakeInstance {
  dbiResourceId: string;
  engine: string;
  engineVersion: string;
  instanceClass: string;
  allocatedStorage: number;
  storageType: string;
  iops: number;
  throughput: number;
  port: number;
  parameterGroup: string;
  securityGroups: string[];
  masterUsername: string;
  tags: Record<string, string>;
}

/**
 * A minimal RDS control plane holding one instance, which the provider creates
 * on the first deploy. `restore` swaps a different physical server in behind
 * the same identifier, as a point-in-time restore's rename swap does.
 */
const fakeRds = () => {
  const calls: string[] = [];
  let instance: FakeInstance | undefined;

  const instanceXml = (i: FakeInstance) => `<DBInstance>
    <DBInstanceIdentifier>${IDENTIFIER}</DBInstanceIdentifier>
    <DBInstanceArn>${ARN}</DBInstanceArn>
    <DbiResourceId>${i.dbiResourceId}</DbiResourceId>
    <DBInstanceStatus>available</DBInstanceStatus>
    <DBInstanceClass>${i.instanceClass}</DBInstanceClass>
    <Engine>${i.engine}</Engine>
    <EngineVersion>${i.engineVersion}</EngineVersion>
    <MasterUsername>${i.masterUsername}</MasterUsername>
    <Endpoint><Address>${IDENTIFIER}.abcdefghijkl.${TEST_REGION}.rds.amazonaws.com</Address><Port>${i.port}</Port></Endpoint>
    <AllocatedStorage>${i.allocatedStorage}</AllocatedStorage>
    <StorageType>${i.storageType}</StorageType>
    <Iops>${i.iops}</Iops>
    <StorageThroughput>${i.throughput}</StorageThroughput>
    <DBParameterGroups><DBParameterGroup><DBParameterGroupName>${i.parameterGroup}</DBParameterGroupName><ParameterApplyStatus>in-sync</ParameterApplyStatus></DBParameterGroup></DBParameterGroups>
    <VpcSecurityGroups>${i.securityGroups
      .map(
        (id) =>
          `<VpcSecurityGroupMembership><VpcSecurityGroupId>${id}</VpcSecurityGroupId><Status>active</Status></VpcSecurityGroupMembership>`,
      )
      .join("")}</VpcSecurityGroups>
    <PubliclyAccessible>false</PubliclyAccessible>
    <IAMDatabaseAuthenticationEnabled>false</IAMDatabaseAuthenticationEnabled>
    <DeletionProtection>false</DeletionProtection>
    <NetworkType>IPV4</NetworkType>
    <EnabledCloudwatchLogsExports></EnabledCloudwatchLogsExports>
    <TagList>${Object.entries(i.tags)
      .map(
        ([key, value]) =>
          `<Tag><Key>${escapeXml(key)}</Key><Value>${escapeXml(value)}</Value></Tag>`,
      )
      .join("")}</TagList>
  </DBInstance>`;

  const respond = (action: string, result: string) =>
    new Response(
      `<${action}Response xmlns="http://rds.amazonaws.com/doc/2014-10-31/"><${action}Result>${result}</${action}Result><ResponseMetadata><RequestId>00000000-0000-0000-0000-000000000000</RequestId></ResponseMetadata></${action}Response>`,
      { status: 200, headers: { "content-type": "text/xml" } },
    );
  const fail = (status: number, code: string, message: string) =>
    new Response(
      `<ErrorResponse xmlns="http://rds.amazonaws.com/doc/2014-10-31/"><Error><Type>Sender</Type><Code>${code}</Code><Message>${escapeXml(message)}</Message></Error><RequestId>00000000-0000-0000-0000-000000000000</RequestId></ErrorResponse>`,
      { status, headers: { "content-type": "text/xml" } },
    );

  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const params = new URLSearchParams(await request.text());
    const action = params.get("Action") ?? "";
    calls.push(action);
    switch (action) {
      case "DescribeDBInstances":
        return instance
          ? respond(action, `<DBInstances>${instanceXml(instance)}</DBInstances>`)
          : fail(404, "DBInstanceNotFound", `DBInstance ${IDENTIFIER} not found.`);
      case "CreateDBInstance": {
        const keys = listParam(params, "Tags", "Key");
        const values = listParam(params, "Tags", "Value");
        instance = {
          dbiResourceId: "db-ORIGINALSERVER",
          engine: params.get("Engine") ?? "",
          engineVersion: params.get("EngineVersion") ?? "",
          instanceClass: params.get("DBInstanceClass") ?? "",
          allocatedStorage: Number(params.get("AllocatedStorage")),
          storageType: params.get("StorageType") ?? "gp3",
          iops: Number(params.get("Iops") ?? 3000),
          throughput: Number(params.get("StorageThroughput") ?? 125),
          port: Number(params.get("Port")),
          parameterGroup: params.get("DBParameterGroupName") ?? "",
          securityGroups: listParam(params, "VpcSecurityGroupIds"),
          masterUsername: params.get("MasterUsername") ?? "",
          tags: Object.fromEntries(keys.map((key, n) => [key, values[n] ?? ""])),
        };
        return respond(action, instanceXml(instance));
      }
      default:
        return fail(400, "UnexpectedAction", `the fake RDS does not handle ${action}`);
    }
  };

  return {
    calls,
    restore: (dbiResourceId: string) => {
      if (instance) instance = { ...instance, dbiResourceId };
    },
    transport: FetchHttpClient.layer.pipe(
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch as typeof globalThis.fetch)),
    ),
  };
};

/** Deploy a stack against the fake RDS with in-memory state, as `force-stale-attrs.test.ts` does. */
const makeHarness = (rds: ReturnType<typeof fakeRds>) => {
  const store: Record<string, Record<string, Record<string, any>>> = {};
  const awsServices = Layer.mergeAll(
    testCredentials,
    Layer.succeed(Region, Effect.succeed(TEST_REGION)),
    NodeServices.layer,
  ).pipe(Layer.provideMerge(rds.transport));
  const deploy = (effect: Effect.Effect<any, any, any>): Effect.Effect<any, any, never> =>
    (effect as Effect.Effect<any, any, never>).pipe(
      Stack.make({
        name: "identity",
        providers: DBInstanceProvider().pipe(Layer.provideMerge(awsServices)) as Layer.Layer<
          any,
          never,
          any
        >,
        state: Layer.effect(
          State,
          Effect.sync(() => InMemoryService(store)),
        ),
      }),
      Effect.flatMap((compiled: any) =>
        Plan.make(compiled).pipe(Effect.flatMap(apply), Effect.provide(compiled.services)),
      ),
      Effect.provide(Layer.succeed(Stage, STAGE)),
      Effect.provide(awsServices),
      provideFreshArtifactStore,
    ) as unknown as Effect.Effect<any, any, never>;
  const row = (fqn: string) =>
    Effect.sync(() => store.identity?.[STAGE]?.[fqn] as ResourceState | undefined);
  return { deploy, row };
};

/** An instance with every association declared, and a migration keyed on its physical server. */
const program = (migrations: Ref.Ref<string[]>) =>
  Effect.gen(function* () {
    const database = yield* DBInstance("Database", {
      dbInstanceIdentifier: IDENTIFIER,
      engine: "postgres",
      engineVersion: "16.3",
      dbInstanceClass: "db.t4g.micro",
      allocatedStorage: 20,
      storageType: "gp3",
      masterUsername: "app",
      masterUserPassword: Redacted.make("not-a-real-password"),
      dbParameterGroupName: "default.postgres16",
      vpcSecurityGroupIds: ["sg-0123456789abcdef0"],
    });
    const Migrate = Action("Migrate", (input: { server: string | undefined }) =>
      Effect.gen(function* () {
        yield* Ref.update(migrations, (servers) => [...servers, input.server ?? "(none)"]);
        return { migrated: input.server };
      }),
    );
    yield* Migrate({ server: database.dbiResourceId });
    return database;
  });

describe(
  "a new physical server behind the same identifier",
  { tags: ["unit", "provider:aws", "provider:aws:rds", "local"] },
  () => {
    it.effect("publishes the new server's attributes and reruns their consumer", () =>
      Effect.gen(function* () {
        const rds = fakeRds();
        const { deploy, row } = makeHarness(rds);
        const migrations = yield* Ref.make<string[]>([]);

        yield* deploy(program(migrations));
        expect(((yield* row("Database"))?.attr as any)?.dbiResourceId).toBe("db-ORIGINALSERVER");
        expect(yield* Ref.get(migrations)).toEqual(["db-ORIGINALSERVER"]);

        rds.restore("db-RESTOREDSERVER");
        const callsBeforeRedeploy = rds.calls.length;
        yield* deploy(program(migrations));

        expect({
          stored: ((yield* row("Database"))?.attr as any)?.dbiResourceId,
          migratedServers: yield* Ref.get(migrations),
        }).toEqual({
          stored: "db-RESTOREDSERVER",
          migratedServers: ["db-ORIGINALSERVER", "db-RESTOREDSERVER"],
        });
        // The instance already matches the props: the update only re-read it.
        expect(
          rds.calls.slice(callsBeforeRedeploy).every((call) => call === "DescribeDBInstances"),
        ).toBe(true);
      }),
    );

    it.effect("stays a no-op while the server is the same", () =>
      Effect.gen(function* () {
        const rds = fakeRds();
        const { deploy, row } = makeHarness(rds);
        const migrations = yield* Ref.make<string[]>([]);

        yield* deploy(program(migrations));
        const created = yield* row("Database");
        const callsAfterCreate = rds.calls.length;

        yield* deploy(program(migrations));

        expect(yield* row("Database")).toEqual(created);
        expect(yield* Ref.get(migrations)).toEqual(["db-ORIGINALSERVER"]);
        // The redeploy only read the instance; it wrote nothing.
        expect(
          rds.calls.slice(callsAfterCreate).every((call) => call === "DescribeDBInstances"),
        ).toBe(true);
      }),
    );
  },
);
