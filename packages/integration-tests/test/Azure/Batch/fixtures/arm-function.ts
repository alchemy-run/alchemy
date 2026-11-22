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

/**
 * The free trial allows one Batch account per region; the other Batch
 * suites use eastus, centralus, westus2, westus3, eastus2 and
 * northcentralus.
 */
export const BATCH_ARM_LOCATION = "southcentralus";

/** The account's auto-storage account, whose keys the binding re-syncs. */
export const AutoStorage = Azure.Storage.StorageAccount("BatchArmAutoStorage", {
  location: BATCH_ARM_LOCATION,
});

export const Account = Effect.gen(function* () {
  const storage = yield* AutoStorage;
  return yield* Azure.Batch.Account("BatchArmAccount", {
    location: BATCH_ARM_LOCATION,
    autoStorage: { storageAccountId: storage.storageAccountId },
  });
});

/** Answer `{ ok, result }`, or `{ ok: false, error }` with a 500 so callers retry. */
const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
  effect.pipe(
    Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result: result ?? null })),
    Effect.catchCause((cause) =>
      HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
    ),
  );

/**
 * Effect-native Azure Function exercising the Batch ARM runtime-action
 * bindings that need no pool (the subscription's Batch pool quota is 0), one
 * route per binding. Routes answer `{ ok, result | error }` with a 500 on
 * error, so a caller retries through the cold start and role propagation,
 * and a real failure shows the ARM error.
 */
export default class BatchArmFunction extends Azure.Functions.Function<BatchArmFunction>()(
  "BatchArmFunction",
  {
    main: import.meta.url,
    // TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const account = yield* Account;
    const syncKeys = yield* Azure.Batch.SynchronizeAutoStorageKeys(account);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        switch (url.pathname) {
          case "/sync-keys":
            return yield* respond(Effect.as(syncKeys(), "synced"));
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }),
    };
  }).pipe(Effect.provide(Layer.mergeAll(Azure.Batch.SynchronizeAutoStorageKeysHttp))),
) {}
