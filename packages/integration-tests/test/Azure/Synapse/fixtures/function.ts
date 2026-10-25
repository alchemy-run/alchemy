import * as Azure from "@alchemy.run/azure";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { accepted } from "../../arm-action-fixture.ts";
import { distilledFromSource } from "../../Functions/fixtures/distilled-source.ts";
import { LOCATION, PASSWORD } from "../fixture.ts";

// Resources the fixture binds. Module-scope so the test stack yields the
// same declarations.

export const Lake = Azure.Storage.StorageAccount("SynapseBindingsLake", {
  location: LOCATION,
  isHnsEnabled: true,
});

export const Workspace = Effect.gen(function* () {
  const lake = yield* Lake;
  const fs = yield* Azure.Storage.BlobContainer("SynapseBindingsFs", {
    storageAccount: lake.storageAccountName,
  });
  return yield* Azure.Synapse.Workspace("SynapseBindingsWs", {
    location: LOCATION,
    defaultDataLakeStorage: {
      accountUrl: lake.primaryEndpoints.dfs.as<string>(),
      filesystem: fs.containerName,
    },
    sqlAdministratorLogin: "sqladminuser",
    sqlAdministratorLoginPassword: PASSWORD,
  });
});

/** The smallest dedicated SQL pool: paused and resumed. */
export const Pool = Effect.gen(function* () {
  const workspace = yield* Workspace;
  return yield* Azure.Synapse.SqlPool("SynapseBindingsDw", {
    workspace: workspace.workspaceName,
    sku: "DW100c",
    storageAccountType: "LRS",
  });
});

/**
 * Effect-native Azure Function exercising the Synapse SQL pool runtime-action
 * bindings on a managed-identity host, one route per binding.
 */
export default class SynapseFunction extends Azure.Functions.Function<SynapseFunction>()(
  "SynapseFunction",
  {
    main: import.meta.url,
    // TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const pool = yield* Pool;
    const pauseSqlPool = yield* Azure.Synapse.PauseSqlPool(pool);
    const resumeSqlPool = yield* Azure.Synapse.ResumeSqlPool(pool);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        switch (new URL(request.url, "http://localhost").pathname) {
          case "/pause":
            return yield* accepted(pauseSqlPool());
          case "/resume":
            return yield* accepted(resumeSqlPool());
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }),
    };
  }).pipe(
    Effect.provide(Layer.mergeAll(Azure.Synapse.PauseSqlPoolHttp, Azure.Synapse.ResumeSqlPoolHttp)),
  ),
) {}
