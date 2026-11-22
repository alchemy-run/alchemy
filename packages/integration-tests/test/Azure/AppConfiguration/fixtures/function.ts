import * as Azure from "@alchemy.run/azure";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { distilledFromSource } from "../../Functions/fixtures/distilled-source.ts";

// Resources the fixture binds. Module-scope so the test stack yields the
// same declarations.

/** Key, label, and value of {@link ReadSetting}. */
export const READ = { key: "Read:Color", label: "prod", value: "blue" } as const;
/** Snapshot the Function creates and archives. */
export const SNAPSHOT = "alchemy-bindings-release";

// Standard: a Free store is limited to one per subscription and region,
// and other suites hold it.
export const Store = Azure.AppConfiguration.ConfigurationStore("AppConfigBindingsStore", {
  sku: "Standard",
});

const setting = (id: string, key: string, value: string, label?: string) =>
  Effect.gen(function* () {
    const store = yield* Store;
    return yield* Azure.AppConfiguration.KeyValue(id, {
      configurationStore: store.configurationStoreName,
      key,
      label,
      value,
      contentType: "text/plain",
    });
  });

/** Read by every read binding. */
export const ReadSetting = setting("AppConfigReadSetting", READ.key, READ.value, READ.label);
/** Deleted by `DeleteKeyValue`. */
export const DoomedSetting = setting("AppConfigDoomedSetting", "Write:Doomed", "doomed", "prod");
/** Deleted by `ConfigurationStoreWrite`. */
export const LevelDoomedSetting = setting("AppConfigLevelDoomedSetting", "Level:Doomed", "doomed");

/** Answer `{ ok, result }`, or `{ ok: false, error }` with a 500 so callers retry. */
const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
  effect.pipe(
    Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
    Effect.catchCause((cause) =>
      HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
    ),
  );

/** The `_tag` an effect fails with (`"none"` when it succeeds). */
const failureTag = <A, E extends { _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.as("none"),
    Effect.catch((error) => Effect.succeed(error._tag)),
  );

/**
 * Effect-native Azure Function exercising every App Configuration
 * data-plane binding on a managed-identity host, one route per binding.
 * Routes answer `{ ok, result | error }` with a 500 on error, so a caller
 * retries through the cold start and role propagation, and a real failure
 * shows the Azure error.
 */
export default class AppConfigFunction extends Azure.Functions.Function<AppConfigFunction>()(
  "AppConfigBindingsFunction",
  {
    main: import.meta.url,
    // TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const store = yield* Store;
    yield* ReadSetting;
    yield* DoomedSetting;
    yield* LevelDoomedSetting;

    const getKeyValue = yield* Azure.AppConfiguration.GetKeyValue(store);
    const getKeyValues = yield* Azure.AppConfiguration.GetKeyValues(store);
    const checkKeyValue = yield* Azure.AppConfiguration.CheckKeyValue(store);
    const checkKeyValues = yield* Azure.AppConfiguration.CheckKeyValues(store);
    const getKeys = yield* Azure.AppConfiguration.GetKeys(store);
    const checkKeys = yield* Azure.AppConfiguration.CheckKeys(store);
    const getLabels = yield* Azure.AppConfiguration.GetLabels(store);
    const checkLabels = yield* Azure.AppConfiguration.CheckLabels(store);
    const getRevisions = yield* Azure.AppConfiguration.GetRevisions(store);
    const checkRevisions = yield* Azure.AppConfiguration.CheckRevisions(store);
    const putKeyValue = yield* Azure.AppConfiguration.PutKeyValue(store);
    const deleteKeyValue = yield* Azure.AppConfiguration.DeleteKeyValue(store);
    const putLock = yield* Azure.AppConfiguration.PutLock(store);
    const deleteLock = yield* Azure.AppConfiguration.DeleteLock(store);
    const createSnapshot = yield* Azure.AppConfiguration.CreateSnapshot(store);
    const getOperationDetails = yield* Azure.AppConfiguration.GetOperationDetails(store);
    const getSnapshot = yield* Azure.AppConfiguration.GetSnapshot(store);
    const getSnapshots = yield* Azure.AppConfiguration.GetSnapshots(store);
    const checkSnapshot = yield* Azure.AppConfiguration.CheckSnapshot(store);
    const checkSnapshots = yield* Azure.AppConfiguration.CheckSnapshots(store);
    const updateSnapshot = yield* Azure.AppConfiguration.UpdateSnapshot(store);
    const read = yield* Azure.AppConfiguration.ConfigurationStoreRead(store);
    const write = yield* Azure.AppConfiguration.ConfigurationStoreWrite(store);
    const readWrite = yield* Azure.AppConfiguration.ConfigurationStoreReadWrite(store);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const value = url.searchParams.get("value") ?? "";
        switch (url.pathname) {
          case "/get":
            return yield* respond(
              Effect.gen(function* () {
                const found = yield* getKeyValue({ key: READ.key, label: READ.label });
                const missing = yield* failureTag(getKeyValue({ key: "Missing:Key" }));
                return { key: found.key, label: found.label, value: found.value, missing };
              }),
            );
          case "/list":
            return yield* respond(
              Effect.map(getKeyValues({ key: "Read:*" }), (page) => ({
                items: page.items.map((kv) => `${kv.key}@${kv.label}=${kv.value}`),
              })),
            );
          case "/check":
            return yield* respond(
              Effect.gen(function* () {
                const found = yield* failureTag(
                  checkKeyValue({ key: READ.key, label: READ.label }),
                );
                const missing = yield* failureTag(checkKeyValue({ key: "Missing:Key" }));
                return { found, missing };
              }),
            );
          case "/check-list":
            return yield* respond(
              Effect.map(failureTag(checkKeyValues({ key: "Read:*" })), (found) => ({ found })),
            );
          case "/keys":
            return yield* respond(
              Effect.map(getKeys({ name: "Read:*" }), (page) => ({
                names: page.items.map((key) => key.name),
              })),
            );
          case "/check-keys":
            return yield* respond(
              Effect.map(failureTag(checkKeys({ name: "Read:*" })), (found) => ({ found })),
            );
          case "/labels":
            return yield* respond(
              Effect.map(getLabels({ name: "prod" }), (page) => ({
                names: page.items.map((label) => label.name),
              })),
            );
          case "/check-labels":
            return yield* respond(
              Effect.map(failureTag(checkLabels({ name: "prod" })), (found) => ({ found })),
            );
          case "/revisions":
            return yield* respond(
              Effect.map(getRevisions({ key: READ.key, label: READ.label }), (page) => ({
                values: page.items.map((kv) => kv.value),
              })),
            );
          case "/check-revisions":
            return yield* respond(
              Effect.map(failureTag(checkRevisions({ key: READ.key })), (found) => ({ found })),
            );

          case "/put":
            return yield* respond(
              Effect.map(
                putKeyValue({
                  key: "Write:Put",
                  label: "prod",
                  value,
                  content_type: "text/plain",
                  tags: { via: "PutKeyValue" },
                }),
                (kv) => ({ key: kv.key, value: kv.value, etag: kv.etag }),
              ),
            );
          case "/delete":
            return yield* respond(
              Effect.gen(function* () {
                const deleted = yield* deleteKeyValue({ key: "Write:Doomed", label: "prod" });
                const again = yield* failureTag(
                  deleteKeyValue({ key: "Write:Doomed", label: "prod" }),
                );
                return { key: deleted.key, value: deleted.value, again };
              }),
            );
          case "/lock":
            return yield* respond(
              Effect.gen(function* () {
                const locked = yield* putLock({ key: "Write:Put", label: "prod" });
                // A locked key-value refuses writes.
                const blocked = yield* failureTag(
                  putKeyValue({ key: "Write:Put", label: "prod", value: "blocked" }),
                );
                return { locked: locked.locked, blocked };
              }),
            );
          case "/unlock":
            return yield* respond(
              Effect.map(deleteLock({ key: "Write:Put", label: "prod" }), (kv) => ({
                locked: kv.locked,
              })),
            );

          case "/create-snapshot":
            return yield* respond(
              Effect.map(
                createSnapshot({
                  name: SNAPSHOT,
                  filters: [{ key: "Read:*", label: READ.label }],
                  retention_period: 3600,
                }),
                (snapshot) => ({ name: snapshot.name, status: snapshot.status }),
              ),
            );
          case "/operation":
            return yield* respond(
              Effect.map(getOperationDetails({ snapshot: SNAPSHOT }), (operation) => ({
                status: operation.status,
              })),
            );
          case "/snapshot":
            return yield* respond(
              Effect.gen(function* () {
                const snapshot = yield* getSnapshot({ name: SNAPSHOT });
                const missing = yield* failureTag(getSnapshot({ name: "missing-snapshot" }));
                return { status: snapshot.status, itemsCount: snapshot.items_count, missing };
              }),
            );
          case "/snapshots":
            return yield* respond(
              Effect.map(getSnapshots({ name: SNAPSHOT }), (page) => ({
                names: page.items.map((snapshot) => snapshot.name),
              })),
            );
          case "/check-snapshot":
            return yield* respond(
              Effect.gen(function* () {
                const found = yield* failureTag(checkSnapshot({ name: SNAPSHOT }));
                const missing = yield* failureTag(checkSnapshot({ name: "missing-snapshot" }));
                return { found, missing };
              }),
            );
          case "/check-snapshots":
            return yield* respond(Effect.map(failureTag(checkSnapshots()), (found) => ({ found })));
          case "/archive":
            return yield* respond(
              Effect.map(updateSnapshot({ name: SNAPSHOT, status: "archived" }), (snapshot) => ({
                status: snapshot.status,
              })),
            );

          case "/read":
            return yield* respond(
              Effect.gen(function* () {
                const found = yield* read.get(READ.key, { label: READ.label });
                const missing = yield* read.get("Missing:Key");
                const listed = yield* read.list({ key: "Read:*" });
                return {
                  value: found?.value,
                  missing: missing === undefined,
                  listed: listed.map((s) => `${s.key}@${s.label}`),
                };
              }),
            );
          case "/write":
            return yield* respond(
              Effect.gen(function* () {
                const written = yield* write.set("Level:Write", value, {
                  label: "prod",
                  contentType: "text/csv",
                  tags: { via: "write" },
                });
                yield* write.delete("Level:Doomed");
                // Deleting a missing setting succeeds.
                yield* write.delete("Level:Doomed");
                return { key: written.key, value: written.value };
              }),
            );
          case "/read-write":
            return yield* respond(
              Effect.gen(function* () {
                yield* readWrite.set("Level:ReadWrite", value);
                const back = yield* readWrite.get("Level:ReadWrite");
                const listed = yield* readWrite.list({ key: "Level:ReadWrite" });
                yield* readWrite.delete("Level:ReadWrite");
                const after = yield* readWrite.get("Level:ReadWrite");
                return {
                  value: back?.value,
                  listed: listed.map((s) => s.value),
                  deleted: after === undefined,
                };
              }),
            );
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Azure.AppConfiguration.GetKeyValueHttp,
        Azure.AppConfiguration.GetKeyValuesHttp,
        Azure.AppConfiguration.CheckKeyValueHttp,
        Azure.AppConfiguration.CheckKeyValuesHttp,
        Azure.AppConfiguration.GetKeysHttp,
        Azure.AppConfiguration.CheckKeysHttp,
        Azure.AppConfiguration.GetLabelsHttp,
        Azure.AppConfiguration.CheckLabelsHttp,
        Azure.AppConfiguration.GetRevisionsHttp,
        Azure.AppConfiguration.CheckRevisionsHttp,
        Azure.AppConfiguration.PutKeyValueHttp,
        Azure.AppConfiguration.DeleteKeyValueHttp,
        Azure.AppConfiguration.PutLockHttp,
        Azure.AppConfiguration.DeleteLockHttp,
        Azure.AppConfiguration.CreateSnapshotHttp,
        Azure.AppConfiguration.GetOperationDetailsHttp,
        Azure.AppConfiguration.GetSnapshotHttp,
        Azure.AppConfiguration.GetSnapshotsHttp,
        Azure.AppConfiguration.CheckSnapshotHttp,
        Azure.AppConfiguration.CheckSnapshotsHttp,
        Azure.AppConfiguration.UpdateSnapshotHttp,
        Azure.AppConfiguration.ConfigurationStoreReadHttp,
        Azure.AppConfiguration.ConfigurationStoreWriteHttp,
        Azure.AppConfiguration.ConfigurationStoreReadWriteHttp,
      ),
    ),
  ),
) {}
