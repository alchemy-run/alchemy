import * as Azure from "@alchemy.run/azure";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { distilledFromSource } from "../../Functions/fixtures/distilled-source.ts";
import { LOCATION, PASSWORD } from "../fixture.ts";

// Resources the fixture binds. Module-scope so the test stack yields the
// same declarations.

export const Lake = Azure.Storage.StorageAccount("SynLakeStorage", {
  location: LOCATION,
  isHnsEnabled: true,
});

export const LakeFs = Effect.gen(function* () {
  const lake = yield* Lake;
  return yield* Azure.Storage.BlobContainer("SynLakeFs", {
    storageAccount: lake.storageAccountName,
  });
});

export const Workspace = Effect.gen(function* () {
  const lake = yield* Lake;
  const fs = yield* LakeFs;
  return yield* Azure.Synapse.Workspace("SynLakeWorkspace", {
    location: LOCATION,
    defaultDataLakeStorage: {
      accountUrl: lake.primaryEndpoints.dfs.as<string>(),
      filesystem: fs.containerName,
    },
    sqlAdministratorLogin: "sqladminuser",
    sqlAdministratorLoginPassword: PASSWORD,
  });
});

/**
 * The development endpoint answers only addresses the firewall admits: the
 * Function's shared outbound addresses and the test runner.
 */
export const AllowAll = Effect.gen(function* () {
  const workspace = yield* Workspace;
  return yield* Azure.Synapse.FirewallRule("SynLakeAllowAll", {
    workspace: workspace.workspaceName,
    name: "allowAll",
    startIpAddress: "0.0.0.0",
    endIpAddress: "255.255.255.255",
  });
});

/** The lake database the write routes create and delete. */
export const DATABASE = "alchemybindings";
/** The lake database `ExecuteChange` creates and drops. */
export const DDL_DATABASE = "alchemyddl";

/** Lake database properties SyMS accepts (a CSV database on a lake path). */
export const databaseProperties = (name: string) => ({
  Source: {
    Provider: "ADLS",
    Location: `abfss://lake@example.dfs.core.windows.net/${name}`,
    Properties: { FormatType: "csv", LinkedServiceName: "lake" },
  },
  Properties: {},
  PublishStatus: "PUBLISHED",
  ObjectVersion: 1,
  ObjectId: "00000000-0000-0000-0000-000000000001",
});

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

/** Names of the entities a SyMS list returns. */
const namesOf = (page: { items?: readonly unknown[] }) =>
  (page.items ?? []).map((item) => (item as { name?: string }).name).sort();

/**
 * Effect-native Azure Function exercising the Synapse lake database
 * bindings on a managed-identity host, one route per binding.
 */
export default class SynLakeFunction extends Azure.Functions.Function<SynLakeFunction>()(
  "SynLakeFunction",
  {
    main: import.meta.url,
    // TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const workspace = yield* Workspace;
    yield* AllowAll;
    const listDatabases = yield* Azure.Synapse.ListDatabases(workspace);
    const getDatabase = yield* Azure.Synapse.GetDatabase(workspace);
    const putDatabase = yield* Azure.Synapse.PutDatabase(workspace);
    const deleteDatabase = yield* Azure.Synapse.DeleteDatabase(workspace);
    const listArtifacts = yield* Azure.Synapse.ListArtifacts(workspace);
    const getArtifact = yield* Azure.Synapse.GetArtifactFromDB(workspace);
    const executeChange = yield* Azure.Synapse.ExecuteChange(workspace);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        switch (url.pathname) {
          case "/db/put":
            return yield* respond(
              Effect.map(
                putDatabase({
                  databaseName: DATABASE,
                  name: DATABASE,
                  type: "DATABASE",
                  properties: databaseProperties(DATABASE),
                }),
                (ddl) => ({ entityName: ddl.entityName, entityType: ddl.entityType }),
              ),
            );
          case "/db/get":
            return yield* respond(
              Effect.map(getDatabase({ databaseName: DATABASE }), (db) => ({
                name: db.name,
                type: db.type,
              })),
            );
          case "/db/list":
            return yield* respond(Effect.map(listDatabases(), (page) => namesOf(page)));
          case "/db/tables":
            return yield* respond(
              Effect.gen(function* () {
                const page = yield* listArtifacts({
                  databaseName: DATABASE,
                  artifactType: "TABLE",
                });
                const missing = yield* failureTag(
                  getArtifact({
                    databaseName: DATABASE,
                    artifactType: "TABLE",
                    artifactName: "missing",
                  }),
                );
                return { tables: namesOf(page), missing };
              }),
            );
          case "/db/delete":
            return yield* respond(
              Effect.as(deleteDatabase({ databaseName: DATABASE }), { deleted: DATABASE }),
            );
          case "/ddl/create":
            return yield* respond(
              Effect.map(
                executeChange({
                  ddls: [
                    {
                      actionType: "CREATE",
                      newEntity: {
                        name: DDL_DATABASE,
                        type: "DATABASE",
                        properties: databaseProperties(DDL_DATABASE),
                      },
                    },
                  ],
                }),
                (result) =>
                  result.syMsApiDdlResponse.map((ddl) => `${ddl.ddlType} ${ddl.entityName}`),
              ),
            );
          case "/ddl/drop":
            // A DROP names the entity as it was published, properties included.
            return yield* respond(
              Effect.map(
                executeChange({
                  ddls: [
                    {
                      actionType: "DROP",
                      oldEntity: {
                        name: DDL_DATABASE,
                        type: "DATABASE",
                        properties: databaseProperties(DDL_DATABASE),
                      },
                    },
                  ],
                }),
                (result) => result.syMsApiDdlResponse.length,
              ),
            );
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Azure.Synapse.ListDatabasesHttp,
        Azure.Synapse.GetDatabaseHttp,
        Azure.Synapse.PutDatabaseHttp,
        Azure.Synapse.DeleteDatabaseHttp,
        Azure.Synapse.ListArtifactsHttp,
        Azure.Synapse.GetArtifactFromDBHttp,
        Azure.Synapse.ExecuteChangeHttp,
      ),
    ),
  ),
) {}
