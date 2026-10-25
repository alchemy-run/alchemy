import * as Azure from "@alchemy.run/azure";
import { Credentials } from "@distilled.cloud/azure";
import * as appconfig from "@distilled.cloud/azure/appconfiguration-data";
import * as authorization from "@distilled.cloud/azure/authorization";
import * as Alchemy from "alchemy";
import { describe, expect } from "alchemy-test";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import AppConfigFunction, {
  DoomedSetting,
  LevelDoomedSetting,
  READ,
  ReadSetting,
  SNAPSHOT,
  Store,
} from "./fixtures/function.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

/** Built-in **App Configuration Data Owner**: the deployer's out-of-band data-plane access. */
const APP_CONFIGURATION_DATA_OWNER = "5ae67dd6-50cb-40e7-96ff-dc2bfa4b606b";

/** Object ID (`oid` claim) of the identity running the tests. */
const callerObjectId = Effect.gen(function* () {
  const config = yield* yield* Credentials;
  const token = Redacted.value(config.bearerToken);
  return yield* Effect.sync(
    () =>
      JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"))
        .oid as string,
  );
});

const Stack = Alchemy.Stack(
  "AzureAppConfigurationBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* AppConfigFunction;
    const store = yield* Store;
    yield* ReadSetting;
    yield* DoomedSetting;
    yield* LevelDoomedSetting;
    // Lets the deployer verify each binding's effect through the data plane.
    const deployer = yield* callerObjectId.pipe(Effect.orDie);
    yield* Azure.Authorization.RoleAssignment("AppConfigDeployerDataOwner", {
      scope: store.configurationStoreId,
      roleDefinitionId: APP_CONFIGURATION_DATA_OWNER,
      principalId: deployer,
    });
    return {
      url: fn.url,
      principalId: fn.principalId,
      endpoint: store.endpoint,
      storeId: store.configurationStoreId,
    };
  }),
);

// Standard store: ~$0.05/hour, prorated, + Flex Consumption (~$0.01/run); ~5 min deploy.
const stack = beforeAll(deploy(Stack), { timeout: 900_000 });

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
 * cold start and role propagation (about 4 minutes), then return the last
 * answer so a real failure shows its Azure error.
 */
const call = (route: string) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    return yield* HttpClient.execute(HttpClientRequest.get(`${url}${route}`)).pipe(
      Effect.timeout("60 seconds"),
      Effect.flatMap((response) => response.json),
      Effect.map((json) => json as Body),
      Effect.flatMap((json) => (json?.ok ? Effect.succeed(json) : Effect.fail(json))),
      Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 48 }),
      Effect.catch((json) => Effect.succeed(json as Body)),
    );
  });

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

/** Retry deployer data-plane calls through the deployer's own role propagation. */
const asDeployer = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.spaced("10 seconds"),
      times: 18,
    }),
    Effect.provide(azure),
  );

/** Read a key-value through the data plane as the deployer (`undefined` when it is gone). */
const deployerGet = (key: string, label?: string) =>
  Effect.gen(function* () {
    const { endpoint } = yield* stack;
    return yield* asDeployer(
      appconfig.GetKeyValue({ endpoint, key, label }).pipe(
        Effect.map((kv) => kv as appconfig.GetKeyValueResponse | undefined),
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
      ),
    );
  });

/**
 * Read a key-value as the deployer until `until` holds (bounded): a read
 * without the writer's `Sync-Token` can trail a write by a few seconds.
 */
const deployerGetUntil = (
  key: string,
  label: string | undefined,
  until: (kv: appconfig.GetKeyValueResponse | undefined) => boolean,
) =>
  deployerGet(key, label).pipe(
    Effect.repeat({ schedule: Schedule.spaced("2 seconds"), until, times: 10 }),
  );

const deployerSnapshot = Effect.gen(function* () {
  const { endpoint } = yield* stack;
  return yield* asDeployer(appconfig.GetSnapshot({ endpoint, name: SNAPSHOT }));
});

/** Role assignments of the Function's identity, without its own host-storage grants. */
const assignmentsOf = (principalId: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    // Every page: a filtered list can answer an empty first page with a `nextLink`.
    const assignments = yield* Stream.runCollect(
      authorization.ListRoleAssignmentForSubscription.items({
        subscriptionId,
        _filter: `principalId eq '${principalId}'`,
      }),
    );
    return Array.from(assignments).filter(
      (a) => !/\/storageaccounts\/[^/]+$/.test(a.properties?.scope?.toLowerCase() ?? ""),
    );
  });

/** Every role on the Function's identity as `<data actions> <scope>`. */
const grantsOf = (principalId: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const grants: string[] = [];
    for (const assignment of yield* assignmentsOf(principalId)) {
      const scope = assignment.properties?.scope?.toLowerCase() ?? "";
      const definition = yield* authorization.GetRoleDefinition({
        scope: `/subscriptions/${subscriptionId}`,
        roleDefinitionId: assignment.properties?.roleDefinitionId?.split("/").pop() ?? "",
      });
      const actions = (definition.properties?.permissions ?? [])
        .flatMap((p) => [...(p.actions ?? []), ...(p.dataActions ?? [])])
        .map((a) => a.replace("Microsoft.AppConfiguration/configurationStores/", ""))
        .sort()
        .join("+");
      grants.push(`${actions} ${scope}`);
    }
    return grants.sort();
  });

describe(
  "App Configuration data-plane bindings on an Azure Function",
  { tags: ["provider:azure", "live"] },
  () => {
    describe("AppConfiguration.GetKeyValue", () => {
      test(
        "reads the deployed setting; a missing key is NotFound",
        Effect.gen(function* () {
          const body = yield* call("/get");
          expectOk(body);
          expect(body.result).toEqual({ ...READ, missing: "NotFound" });
        }),
        { timeout: 300_000 },
      );
    });

    describe("AppConfiguration.GetKeyValues", () => {
      test(
        "lists the settings under a key prefix",
        Effect.gen(function* () {
          const body = yield* call("/list");
          expectOk(body);
          expect(body.result.items).toEqual([`${READ.key}@${READ.label}=${READ.value}`]);
        }),
        { timeout: 300_000 },
      );
    });

    describe("AppConfiguration.CheckKeyValue", () => {
      test(
        "finds the deployed setting; a missing key is NotFound",
        Effect.gen(function* () {
          const body = yield* call("/check");
          expectOk(body);
          expect(body.result).toEqual({ found: "none", missing: "NotFound" });
        }),
        { timeout: 300_000 },
      );
    });

    describe("AppConfiguration.CheckKeyValues", () => {
      test(
        "checks the key-value list",
        Effect.gen(function* () {
          const body = yield* call("/check-list");
          expectOk(body);
          expect(body.result).toEqual({ found: "none" });
        }),
        { timeout: 300_000 },
      );
    });

    describe("AppConfiguration.GetKeys", () => {
      test(
        "lists the deployed key",
        Effect.gen(function* () {
          const body = yield* call("/keys");
          expectOk(body);
          expect(body.result.names).toEqual([READ.key]);
        }),
        { timeout: 300_000 },
      );
    });

    describe("AppConfiguration.CheckKeys", () => {
      test(
        "checks the key list",
        Effect.gen(function* () {
          const body = yield* call("/check-keys");
          expectOk(body);
          expect(body.result).toEqual({ found: "none" });
        }),
        { timeout: 300_000 },
      );
    });

    describe("AppConfiguration.GetLabels", () => {
      test(
        "lists the deployed label",
        Effect.gen(function* () {
          const body = yield* call("/labels");
          expectOk(body);
          expect(body.result.names).toEqual([READ.label]);
        }),
        { timeout: 300_000 },
      );
    });

    describe("AppConfiguration.CheckLabels", () => {
      test(
        "checks the label list",
        Effect.gen(function* () {
          const body = yield* call("/check-labels");
          expectOk(body);
          expect(body.result).toEqual({ found: "none" });
        }),
        { timeout: 300_000 },
      );
    });

    describe("AppConfiguration.GetRevisions", () => {
      test(
        "lists the deployed revision",
        Effect.gen(function* () {
          const body = yield* call("/revisions");
          expectOk(body);
          expect(body.result.values).toEqual([READ.value]);
        }),
        { timeout: 300_000 },
      );
    });

    describe("AppConfiguration.CheckRevisions", () => {
      test(
        "checks the revision list",
        Effect.gen(function* () {
          const body = yield* call("/check-revisions");
          expectOk(body);
          expect(body.result).toEqual({ found: "none" });
        }),
        { timeout: 300_000 },
      );
    });

    describe("AppConfiguration.PutKeyValue", () => {
      test(
        "writes a setting the deployer reads back",
        Effect.gen(function* () {
          const body = yield* call("/put?value=put-by-function");
          expectOk(body);
          expect({ key: body.result.key, value: body.result.value }).toEqual({
            key: "Write:Put",
            value: "put-by-function",
          });
          const observed = yield* deployerGetUntil(
            "Write:Put",
            "prod",
            (kv) => kv?.value === "put-by-function",
          );
          expect({
            value: observed?.value,
            contentType: observed?.content_type,
            tags: observed?.tags,
          }).toEqual({
            value: "put-by-function",
            contentType: "text/plain",
            tags: { via: "PutKeyValue" },
          });
        }),
        { timeout: 300_000 },
      );
    });

    describe("AppConfiguration.PutLock", () => {
      test(
        "locks the setting so writes conflict",
        Effect.gen(function* () {
          const body = yield* call("/lock");
          expectOk(body);
          expect(body.result).toEqual({ locked: true, blocked: "Conflict" });
          const observed = yield* deployerGetUntil(
            "Write:Put",
            "prod",
            (kv) => kv?.locked === true,
          );
          expect({ locked: observed?.locked, value: observed?.value }).toEqual({
            locked: true,
            value: "put-by-function",
          });
        }),
        { timeout: 300_000 },
      );
    });

    describe("AppConfiguration.DeleteLock", () => {
      test(
        "unlocks the setting",
        Effect.gen(function* () {
          const body = yield* call("/unlock");
          expectOk(body);
          expect(body.result).toEqual({ locked: false });
          const observed = yield* deployerGetUntil(
            "Write:Put",
            "prod",
            (kv) => kv?.locked === false,
          );
          expect(observed?.locked).toEqual(false);
        }),
        { timeout: 300_000 },
      );
    });

    describe("AppConfiguration.DeleteKeyValue", () => {
      test(
        "deletes the deployed setting",
        Effect.gen(function* () {
          const body = yield* call("/delete");
          expectOk(body);
          expect(body.result).toEqual({ key: "Write:Doomed", value: "doomed", again: "none" });
          const observed = yield* deployerGetUntil(
            "Write:Doomed",
            "prod",
            (kv) => kv === undefined,
          );
          expect(observed).toEqual(undefined);
        }),
        { timeout: 300_000 },
      );
    });

    describe("AppConfiguration.CreateSnapshot", () => {
      test(
        "creates a snapshot of the read settings",
        Effect.gen(function* () {
          const body = yield* call("/create-snapshot");
          expectOk(body);
          expect(body.result.name).toEqual(SNAPSHOT);
          const observed = yield* deployerSnapshot;
          expect(observed.filters.map((filter) => filter.key)).toEqual(["Read:*"]);
        }),
        { timeout: 300_000 },
      );
    });

    describe("AppConfiguration.GetOperationDetails", () => {
      test(
        "reports the snapshot creation as Succeeded",
        Effect.gen(function* () {
          const body = yield* call("/operation").pipe(
            Effect.repeat({
              schedule: Schedule.spaced("5 seconds"),
              until: (b) => b.result?.status === "Succeeded",
              times: 12,
            }),
          );
          expectOk(body);
          expect(body.result).toEqual({ status: "Succeeded" });
        }),
        { timeout: 300_000 },
      );
    });

    describe("AppConfiguration.GetSnapshot", () => {
      test(
        "reads the ready snapshot; a missing one is NotFound",
        Effect.gen(function* () {
          const body = yield* call("/snapshot");
          expectOk(body);
          expect(body.result).toEqual({ status: "ready", itemsCount: 1, missing: "NotFound" });
        }),
        { timeout: 300_000 },
      );
    });

    describe("AppConfiguration.GetSnapshots", () => {
      test(
        "lists the snapshot",
        Effect.gen(function* () {
          const body = yield* call("/snapshots");
          expectOk(body);
          expect(body.result.names).toEqual([SNAPSHOT]);
        }),
        { timeout: 300_000 },
      );
    });

    describe("AppConfiguration.CheckSnapshot", () => {
      test(
        "finds the snapshot; a missing one is NotFound",
        Effect.gen(function* () {
          const body = yield* call("/check-snapshot");
          expectOk(body);
          expect(body.result).toEqual({ found: "none", missing: "NotFound" });
        }),
        { timeout: 300_000 },
      );
    });

    describe("AppConfiguration.CheckSnapshots", () => {
      test(
        "checks the snapshot list",
        Effect.gen(function* () {
          const body = yield* call("/check-snapshots");
          expectOk(body);
          expect(body.result).toEqual({ found: "none" });
        }),
        { timeout: 300_000 },
      );
    });

    describe("AppConfiguration.UpdateSnapshot", () => {
      test(
        "archives the snapshot",
        Effect.gen(function* () {
          const body = yield* call("/archive");
          expectOk(body);
          expect(body.result).toEqual({ status: "archived" });
          const observed = yield* deployerSnapshot.pipe(
            Effect.repeat({
              schedule: Schedule.spaced("2 seconds"),
              until: (snapshot) => snapshot.status === "archived",
              times: 10,
            }),
          );
          expect(observed.status).toEqual("archived");
        }),
        { timeout: 300_000 },
      );
    });

    describe("AppConfiguration.ConfigurationStoreRead", () => {
      test(
        "gets a setting, misses a missing one, and lists by prefix",
        Effect.gen(function* () {
          const body = yield* call("/read");
          expectOk(body);
          expect(body.result).toEqual({
            value: READ.value,
            missing: true,
            listed: [`${READ.key}@${READ.label}`],
          });
        }),
        { timeout: 300_000 },
      );
    });

    describe("AppConfiguration.ConfigurationStoreWrite", () => {
      test(
        "sets a setting and deletes another",
        Effect.gen(function* () {
          const body = yield* call("/write?value=written-by-write");
          expectOk(body);
          expect(body.result).toEqual({ key: "Level:Write", value: "written-by-write" });
          const written = yield* deployerGetUntil(
            "Level:Write",
            "prod",
            (kv) => kv?.value === "written-by-write",
          );
          expect({
            value: written?.value,
            contentType: written?.content_type,
            tags: written?.tags,
          }).toEqual({
            value: "written-by-write",
            contentType: "text/csv",
            tags: { via: "write" },
          });
          const doomed = yield* deployerGetUntil(
            "Level:Doomed",
            undefined,
            (kv) => kv === undefined,
          );
          expect(doomed).toEqual(undefined);
        }),
        { timeout: 300_000 },
      );
    });

    describe("AppConfiguration.ConfigurationStoreReadWrite", () => {
      test(
        "sets, reads back, lists, and deletes a setting",
        Effect.gen(function* () {
          const body = yield* call("/read-write?value=round-trip");
          expectOk(body);
          expect(body.result).toEqual({
            value: "round-trip",
            listed: ["round-trip"],
            deleted: true,
          });
          const observed = yield* deployerGetUntil(
            "Level:ReadWrite",
            undefined,
            (kv) => kv === undefined,
          );
          expect(observed).toEqual(undefined);
        }),
        { timeout: 300_000 },
      );
    });

    describe("AzureBindings.Bind least privilege", () => {
      test(
        "assigns exactly each binding's data actions, scoped to the store",
        Effect.gen(function* () {
          const outputs = yield* stack;
          expect(outputs.principalId).toMatch(/^[0-9a-f-]{36}$/);
          const store = outputs.storeId.toLowerCase();
          const expected = [
            `keyValues/read ${store}`,
            `keyValues/write ${store}`,
            `keyValues/delete ${store}`,
            `keyValues/delete+keyValues/write ${store}`,
            `snapshots/read ${store}`,
            `snapshots/write ${store}`,
            `snapshots/archive/action ${store}`,
          ].sort();
          // The filtered assignment list can trail the assignments by seconds.
          const grants = yield* grantsOf(outputs.principalId!).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("5 seconds"),
              until: (listed) => listed.length >= expected.length,
              times: 12,
            }),
            Effect.provide(azure),
          );
          expect(grants).toEqual(expected);
        }),
        { timeout: 120_000 },
      );
    });
  },
);

// Destroy, then prove every role assigned to the Function's identity is gone.
afterAll.skipIf(!!process.env.NO_DESTROY)(
  Effect.gen(function* () {
    const { principalId } = yield* stack;
    yield* destroy(Stack);
    expect(principalId).toMatch(/^[0-9a-f-]{36}$/);
    const remaining = yield* assignmentsOf(principalId!).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("5 seconds"),
        until: (assignments) => assignments.length === 0,
        times: 12,
      }),
    );
    expect(remaining.map((a) => a.properties?.scope)).toEqual([]);
  }).pipe(Effect.provide(azure)),
  { timeout: 900_000 },
);
