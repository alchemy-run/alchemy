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

/** Streaming units the `/scale` route scales the running job to. */
export const SCALED_UNITS = 3;

/** Blob input and output of the job, read and written with its identity. */
export const Data = Azure.Storage.StorageAccount("SaBindingsData");

const container = (id: string, name: string) =>
  Effect.gen(function* () {
    const account = yield* Data;
    return yield* Azure.Storage.BlobContainer(id, {
      storageAccount: account.storageAccountName,
      name,
    });
  });

/**
 * A startable job: a system-assigned identity with **Storage Blob Data
 * Contributor** on {@link Data}, a blob input, a blob output and a
 * pass-through query on 1 streaming unit.
 */
export const Job = Effect.gen(function* () {
  const account = yield* Data;
  yield* container("SaBindingsIncoming", "incoming");
  yield* container("SaBindingsArchive", "archive");
  const job = yield* Azure.StreamAnalytics.StreamingJob("SaBindingsJob", {
    identity: "SystemAssigned",
  });
  yield* Azure.Authorization.RoleAssignment("SaBindingsJobStorage", {
    scope: account.storageAccountId,
    roleDefinitionId: Azure.Authorization.BuiltInRole.StorageBlobDataContributor,
    principalId: job.principalId.as<string>(),
    principalType: "ServicePrincipal",
  });
  yield* Azure.StreamAnalytics.Input("SaBindingsEvents", {
    resourceGroup: job.resourceGroup,
    streamingJob: job.jobName,
    name: "events",
    type: "Stream",
    datasource: {
      type: "Microsoft.Storage/Blob",
      properties: {
        storageAccounts: [{ accountName: account.storageAccountName }],
        container: "incoming",
        pathPattern: "events/{date}",
        dateFormat: "yyyy/MM/dd",
        authenticationMode: "Msi",
      },
    },
    serialization: { type: "Json", properties: { encoding: "UTF8" } },
  });
  yield* Azure.StreamAnalytics.Output("SaBindingsArchiveOutput", {
    resourceGroup: job.resourceGroup,
    streamingJob: job.jobName,
    name: "archive",
    datasource: {
      type: "Microsoft.Storage/Blob",
      properties: {
        storageAccounts: [{ accountName: account.storageAccountName }],
        container: "archive",
        pathPattern: "{date}",
        dateFormat: "yyyy/MM/dd",
        authenticationMode: "Msi",
      },
    },
    serialization: { type: "Json", properties: { encoding: "UTF8", format: "LineSeparated" } },
  });
  yield* Azure.StreamAnalytics.Transformation("SaBindingsQuery", {
    resourceGroup: job.resourceGroup,
    streamingJob: job.jobName,
    query: "SELECT * INTO [archive] FROM [events]",
    streamingUnits: 1,
  });
  return job;
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
 * Effect-native Azure Function exercising every Stream Analytics
 * runtime-action binding on a managed-identity host, one route per binding.
 * Routes answer `{ ok, result | error }` with a 500 on error, so a caller
 * retries through the cold start and role propagation, and a real failure
 * shows the ARM error.
 */
export default class StreamAnalyticsFunction extends Azure.Functions.Function<StreamAnalyticsFunction>()(
  "StreamAnalyticsFunction",
  {
    main: import.meta.url,
    // TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const job = yield* Job;

    const startJob = yield* Azure.StreamAnalytics.StartStreamingJob(job);
    const scaleJob = yield* Azure.StreamAnalytics.ScaleStreamingJob(job);
    const stopJob = yield* Azure.StreamAnalytics.StopStreamingJob(job);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        switch (url.pathname) {
          case "/start":
            return yield* respond(
              Effect.as(startJob({ outputStartMode: "JobStartTime" }), "started"),
            );
          case "/scale":
            return yield* respond(Effect.as(scaleJob({ streamingUnits: SCALED_UNITS }), "scaled"));
          case "/stop":
            return yield* respond(Effect.as(stopJob(), "stopped"));
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Azure.StreamAnalytics.StartStreamingJobHttp,
        Azure.StreamAnalytics.ScaleStreamingJobHttp,
        Azure.StreamAnalytics.StopStreamingJobHttp,
      ),
    ),
  ),
) {}
