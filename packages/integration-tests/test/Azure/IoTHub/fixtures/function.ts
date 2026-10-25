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
 * A Basic hub: the free F1 tier allows one hub per subscription and the
 * IotHub suite holds it; the device registry jobs work on every tier.
 */
export const Hub = Azure.IoTHub.IotHub("IoTHubBindingsHub", {
  sku: "B1",
  capacity: 1,
  // Omitted, a paid-tier hub fails with `Invalid PartitionCount 0` (IH400016).
  partitionCount: 2,
});

/** Where the hub writes exports and reads imports, through container SAS URIs. */
export const Data = Azure.Storage.StorageAccount("IoTHubBindingsData");

/** Container the export and import jobs use. */
export const DEVICES_CONTAINER = "devices";

export const Devices = Effect.gen(function* () {
  const account = yield* Data;
  return yield* Azure.Storage.BlobContainer("IoTHubBindingsDevices", {
    storageAccount: account.storageAccountName,
    name: DEVICES_CONTAINER,
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
 * Effect-native Azure Function exercising every IoT Hub runtime-action
 * binding on a managed-identity host, one route per binding. The test
 * passes the container SAS URI in `?sas=`. Routes answer
 * `{ ok, result | error }` with a 500 on error, so a caller retries through
 * the cold start and role propagation, and a real failure shows the ARM
 * error.
 */
export default class IoTHubFunction extends Azure.Functions.Function<IoTHubFunction>()(
  "IoTHubFunction",
  {
    main: import.meta.url,
    // TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const hub = yield* Hub;

    const exportDevices = yield* Azure.IoTHub.ExportDevices(hub);
    const importDevices = yield* Azure.IoTHub.ImportDevices(hub);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const sas = url.searchParams.get("sas") ?? "";
        const blob = url.searchParams.get("blob") ?? "";
        switch (url.pathname) {
          case "/export":
            return yield* respond(
              Effect.map(
                exportDevices({
                  exportBlobContainerUri: sas,
                  excludeKeys: true,
                  exportBlobName: blob,
                }),
                (job) => ({ jobId: job.jobId, type: job.type }),
              ),
            );
          case "/import":
            return yield* respond(
              Effect.map(
                importDevices({
                  inputBlobContainerUri: sas,
                  outputBlobContainerUri: sas,
                  inputBlobName: blob,
                }),
                (job) => ({ jobId: job.jobId, type: job.type }),
              ),
            );
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }),
    };
  }).pipe(
    Effect.provide(Layer.mergeAll(Azure.IoTHub.ExportDevicesHttp, Azure.IoTHub.ImportDevicesHttp)),
  ),
) {}
