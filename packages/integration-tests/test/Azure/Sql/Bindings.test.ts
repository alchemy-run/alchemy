import * as Azure from "@alchemy.run/azure";
import { Credentials } from "@distilled.cloud/azure";
import * as authorization from "@distilled.cloud/azure/authorization";
import * as sql from "@distilled.cloud/azure/sql";
import * as storage from "@distilled.cloud/azure/storage";
import * as blob from "@distilled.cloud/azure/storage-blob";
import * as Alchemy from "alchemy";
import { describe, expect } from "alchemy-test";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import SqlFunction, {
  ADMIN_PASSWORD,
  AllowAzure,
  App,
  Backups,
  Bacpacs,
  Group,
  Pool,
  Pooled,
  Primary,
  Secondary,
} from "./fixtures/function.ts";
import { SQL_TAGS } from "./harness.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

/** Object ID (`oid` claim) of the identity running the tests. */
const deployerObjectId = Effect.gen(function* () {
  const config = yield* yield* Credentials;
  const token = Redacted.value(config.bearerToken);
  return yield* Effect.sync(
    () =>
      JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"))
        .oid as string,
  );
});

const Stack = Alchemy.Stack(
  "AzureSqlBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* SqlFunction;
    const primary = yield* Primary;
    const secondary = yield* Secondary;
    yield* AllowAzure;
    const app = yield* App;
    const pool = yield* Pool;
    yield* Pooled;
    const group = yield* Group;
    const account = yield* Backups;
    const container = yield* Bacpacs;
    // The deployer lists the exported BACPAC.
    const deployer = yield* deployerObjectId.pipe(Effect.orDie);
    yield* Azure.Authorization.RoleAssignment("SqlBindingsDeployerBlobReader", {
      scope: account.storageAccountId,
      roleDefinitionId: Azure.Authorization.BuiltInRole.StorageBlobDataReader,
      principalId: deployer,
      principalType: "ServicePrincipal",
    });
    return {
      url: fn.url,
      principalId: fn.principalId,
      hostStorageAccount: fn.storageAccountName,
      resourceGroup: primary.resourceGroup,
      primaryName: primary.serverName,
      secondaryName: secondary.serverName,
      secondaryId: secondary.serverId,
      appName: app.databaseName,
      appId: app.databaseId,
      poolId: pool.elasticPoolId,
      groupName: group.failoverGroupName,
      storageAccountName: account.storageAccountName,
      storageResourceGroup: account.resourceGroup,
      containerName: container.containerName,
    };
  }),
);

// Two logical servers (free), three Basic databases and a Basic elastic
// pool (~$0.13/hour together), a storage account, and a Flex Consumption
// app: ~$0.05/run; ~15 min deploy (the failover group seeds its
// geo-secondary).
const stack = beforeAll(deploy(Stack), { timeout: 1_800_000 });

/** Deployer credentials and environment for out-of-band checks and hooks. */
const azure = Layer.mergeAll(Azure.environmentFromAuthProvider(), Azure.fromAuthProvider()).pipe(
  Layer.provideMerge(Azure.AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

type Body = { ok: boolean; result?: any; error?: string };

/**
 * Call a binding route until it answers `ok`, through the Flex Consumption
 * cold start and role propagation, then return the last answer so a real
 * failure shows its Azure error.
 */
const call = (route: string) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    return yield* HttpClient.get(`${url}${route}`).pipe(
      Effect.timeout("90 seconds"),
      Effect.flatMap((response) => response.json),
      Effect.map((body) => body as Body),
      Effect.flatMap((body) => (body?.ok ? Effect.succeed(body) : Effect.fail(body))),
      Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 60 }),
      Effect.catch((body) => Effect.succeed(body as Body)),
    );
  });

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

// --- out-of-band reads (deployer credentials) ---

const subscription = Effect.map(Azure.AzureEnvironment.current, (env) => env.subscriptionId).pipe(
  Effect.provide(azure),
);

/** Role of `serverName` in the failover group. */
const groupRole = (serverName: string) =>
  Effect.gen(function* () {
    const subscriptionId = yield* subscription;
    const { resourceGroup, groupName } = yield* stack;
    const group = yield* sql.GetFailoverGroup({
      subscriptionId,
      resourceGroupName: resourceGroup,
      serverName,
      failoverGroupName: groupName,
    });
    return group.properties?.replicationRole;
  }).pipe(Effect.provide(azure));

/** The group's replication state, seen from its primary. */
const groupState = (serverName: string) =>
  Effect.gen(function* () {
    const subscriptionId = yield* subscription;
    const { resourceGroup, groupName } = yield* stack;
    const group = yield* sql.GetFailoverGroup({
      subscriptionId,
      resourceGroupName: resourceGroup,
      serverName,
      failoverGroupName: groupName,
    });
    return group.properties?.replicationState;
  }).pipe(Effect.provide(azure));

/**
 * Both servers' roles once they agree (one `Primary`, one `Secondary`): a
 * read during a failover can answer the old role on one side.
 */
const settledRoles = Effect.gen(function* () {
  const { primaryName, secondaryName } = yield* stack;
  const primary = yield* groupRole(primaryName);
  const secondary = yield* groupRole(secondaryName);
  return { primary, secondary };
}).pipe(
  Effect.repeat({
    schedule: Schedule.spaced("10 seconds"),
    until: ({ primary, secondary }) =>
      (primary === "Primary" && secondary === "Secondary") ||
      (primary === "Secondary" && secondary === "Primary"),
    times: 36,
  }),
);

/** Poll the group until `serverName` is its primary (a failover takes 1-5 min). */
const untilPrimary = (serverName: string) =>
  groupRole(serverName).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("10 seconds"),
      until: (observed) => observed === "Primary",
      times: 36,
    }),
  );

/** Make the configured primary server the group's primary again, out of band. */
const failBack = Effect.gen(function* () {
  const { primaryName, resourceGroup, groupName } = yield* stack;
  const roles = yield* settledRoles;
  if (roles.primary === "Primary") return roles;
  const subscriptionId = yield* subscription;
  yield* sql
    .FailoverGroupsFailover({
      subscriptionId,
      resourceGroupName: resourceGroup,
      serverName: primaryName,
      failoverGroupName: groupName,
    })
    .pipe(Effect.provide(azure));
  yield* untilPrimary(primaryName);
  return yield* settledRoles;
});

/** Names of the blobs in the export container. */
const exportedBlobs = Effect.gen(function* () {
  const { storageAccountName, containerName } = yield* stack;
  const page = yield* blob
    .ListContainerBlobFlatSegment({
      url: `https://${storageAccountName}.blob.core.windows.net`,
      containerName,
    })
    .pipe(
      // The deployer's data role trails the deploy by a few minutes.
      Effect.retry({
        while: (e) => e._tag === "SchemaRegistryStorageAccessDenied",
        schedule: Schedule.spaced("10 seconds"),
        times: 18,
      }),
    );
  return (page.Segment?.BlobItems ?? []).map((item) => item.Name?.content ?? "");
}).pipe(Effect.provide(azure));

/** Role assignments of the Function's identity, without its own host-storage grants. */
const assignmentsOf = (principalId: string, hostStorageAccount: string | undefined) =>
  Effect.gen(function* () {
    const subscriptionId = yield* subscription;
    // Every page: a filtered list can answer an empty first page with a `nextLink`.
    const assignments = yield* Stream.runCollect(
      authorization.ListRoleAssignmentForSubscription.items({
        subscriptionId,
        _filter: `principalId eq '${principalId}'`,
      }),
    );
    const host = `/storageaccounts/${(hostStorageAccount ?? "").toLowerCase()}`;
    return Array.from(assignments).filter(
      (a) => !(a.properties?.scope?.toLowerCase() ?? "").endsWith(host),
    );
  });

/** Every role on the Function's identity as `<actions> <scope>`. */
const grantsOf = (principalId: string, hostStorageAccount: string | undefined) =>
  Effect.gen(function* () {
    const subscriptionId = yield* subscription;
    const grants: string[] = [];
    for (const assignment of yield* assignmentsOf(principalId, hostStorageAccount)) {
      const scope = assignment.properties?.scope?.toLowerCase() ?? "";
      const definition = yield* authorization.GetRoleDefinition({
        scope: `/subscriptions/${subscriptionId}`,
        roleDefinitionId: assignment.properties?.roleDefinitionId?.split("/").pop() ?? "",
      });
      const actions = (definition.properties?.permissions ?? [])
        .flatMap((p) => [...(p.actions ?? []), ...(p.dataActions ?? [])])
        .sort()
        .join("+");
      grants.push(`${actions} ${scope}`);
    }
    return grants.sort();
  });

describe("Azure SQL bindings on an Azure Function", { tags: SQL_TAGS }, () => {
  // Pause, resume and restore points apply only to dedicated SQL pools
  // (DW SKUs, ~$1.20/hour). The Basic database proves the grant and the
  // request: Azure answers its typed rejection.
  describe("Sql.PauseDatabase", () => {
    test(
      "reaches the bound database",
      Effect.gen(function* () {
        const body = yield* call("/pause-database");
        expectOk(body);
        expect(body.result.rejected).toEqual("FeatureDisabledOnSelectedEdition");
      }),
      { timeout: 900_000 },
    );
  });

  describe("Sql.ResumeDatabase", () => {
    test(
      "reaches the bound database",
      Effect.gen(function* () {
        const body = yield* call("/resume-database");
        expectOk(body);
        expect(body.result.rejected).toEqual("FeatureDisabledOnSelectedEdition");
      }),
      { timeout: 900_000 },
    );
  });

  describe("Sql.CreateRestorePoint", () => {
    test(
      "reaches the bound database",
      Effect.gen(function* () {
        const body = yield* call("/create-restore-point");
        expectOk(body);
        expect(body.result.rejected).toEqual("FeatureDisabledOnSelectedEdition");
      }),
      { timeout: 900_000 },
    );
  });

  describe("Sql.FailoverDatabase", () => {
    test(
      "fails the bound database over to another replica",
      Effect.gen(function* () {
        const body = yield* call("/failover-database");
        expectOk(body);
        expect(body.result).toEqual({ rejected: false });
      }),
      { timeout: 900_000 },
    );
  });

  describe("Sql.FailoverElasticPool", () => {
    test(
      "fails the bound elastic pool over to another replica",
      Effect.gen(function* () {
        const body = yield* call("/failover-elastic-pool");
        expectOk(body);
        expect(body.result).toEqual({ rejected: false });
      }),
      { timeout: 900_000 },
    );
  });

  describe("Sql.ExportDatabase", () => {
    test(
      "exports the bound database to a BACPAC blob",
      Effect.gen(function* () {
        const { storageAccountName, storageResourceGroup, containerName } = yield* stack;
        const subscriptionId = yield* subscription;
        const keys = yield* storage
          .ListStorageAccountKeys({
            subscriptionId,
            resourceGroupName: storageResourceGroup,
            accountName: storageAccountName,
          })
          .pipe(Effect.provide(azure));
        const key = keys.keys?.[0]?.value;
        const storageKey = key ?? "";
        const uri = `https://${storageAccountName}.blob.core.windows.net/${containerName}/app.bacpac`;
        const query = new URLSearchParams({ uri, key: storageKey, password: ADMIN_PASSWORD });
        const body = yield* call(`/export-database?${query}`);
        expectOk(body);
        // A Basic database exports in a few minutes.
        const blobs = yield* exportedBlobs.pipe(
          Effect.repeat({
            schedule: Schedule.spaced("15 seconds"),
            until: (names) => names.includes("app.bacpac"),
            times: 40,
          }),
        );
        expect(blobs).toEqual(["app.bacpac"]);
      }),
      { timeout: 1_200_000 },
    );
  });

  describe("Sql.FailoverFailoverGroup", () => {
    test(
      "promotes the bound partner server",
      Effect.gen(function* () {
        const { primaryName, secondaryName } = yield* stack;
        // A retried test may find the group failed over: fail it back first.
        expect(yield* failBack).toEqual({ primary: "Primary", secondary: "Secondary" });
        // A failover right after the deploy is accepted but dropped while the
        // geo-secondary still seeds: wait for `CATCH_UP`.
        const state = yield* groupState(primaryName).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("15 seconds"),
            until: (observed) => observed === "CATCH_UP",
            times: 40,
          }),
        );
        expect(state).toEqual("CATCH_UP");
        const body = yield* call("/failover-failover-group");
        expectOk(body);
        yield* untilPrimary(secondaryName);
        expect(yield* settledRoles).toEqual({ primary: "Secondary", secondary: "Primary" });
        // Fail back so the stack deletes the group from its configured primary.
        expect(yield* failBack).toEqual({ primary: "Primary", secondary: "Secondary" });
      }),
      { timeout: 1_800_000 },
    );
  });

  describe("AzureBindings.Bind least privilege", () => {
    test(
      "assigns exactly each binding's action on its resource only",
      Effect.gen(function* () {
        const outputs = yield* stack;
        expect(outputs.principalId).toMatch(/^[0-9a-f-]{36}$/);
        // Role-assignment lists trail new assignments by a few minutes.
        const grants = yield* grantsOf(outputs.principalId!, outputs.hostStorageAccount).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("10 seconds"),
            until: (listed) => listed.length >= 7,
            times: 18,
          }),
          Effect.provide(azure),
        );
        const db = outputs.appId.toLowerCase();
        expect(grants).toEqual(
          [
            `Microsoft.Sql/servers/databases/pause/action ${db}`,
            `Microsoft.Sql/servers/databases/resume/action ${db}`,
            `Microsoft.Sql/servers/databases/restorePoints/action ${db}`,
            `Microsoft.Sql/servers/databases/failover/action ${db}`,
            `Microsoft.Sql/servers/databases/export/action ${db}`,
            `Microsoft.Sql/servers/elasticPools/failover/action ${outputs.poolId.toLowerCase()}`,
            `Microsoft.Sql/servers/failoverGroups/failover/action ${outputs.secondaryId.toLowerCase()}/failovergroups/${outputs.groupName.toLowerCase()}`,
          ].sort(),
        );
      }),
      { timeout: 300_000 },
    );
  });
});

// Destroy, then prove the servers and every role assigned to the
// Function's identity are gone.
afterAll.skipIf(!!process.env.NO_DESTROY)(
  Effect.gen(function* () {
    const { principalId, hostStorageAccount, resourceGroup, primaryName, secondaryName } =
      yield* stack;
    yield* destroy(Stack);
    expect(principalId).toMatch(/^[0-9a-f-]{36}$/);
    const remaining = yield* assignmentsOf(principalId!, hostStorageAccount).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("10 seconds"),
        until: (assignments) => assignments.length === 0,
        times: 24,
      }),
    );
    expect(remaining.map((a) => a.properties?.scope)).toEqual([]);
    const subscriptionId = yield* subscription;
    for (const serverName of [primaryName, secondaryName]) {
      const status = yield* sql
        .GetServer({ subscriptionId, resourceGroupName: resourceGroup, serverName })
        .pipe(
          Effect.as("found" as const),
          Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], () =>
            Effect.succeed("gone" as const),
          ),
          Effect.repeat({
            schedule: Schedule.spaced("10 seconds"),
            until: (observed) => observed === "gone",
            times: 18,
          }),
        );
      expect(status).toEqual("gone");
    }
  }).pipe(Effect.provide(azure)),
  { timeout: 1_800_000 },
);
