import * as Azure from "@alchemy.run/azure";
import * as Output from "alchemy/Output";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { distilledFromSource } from "./distilled-source.ts";

// Resources the Effect function app hosts on and consumes. Module-scope so
// tests can yield the same declarations.

/** Flex Consumption plan: one app per plan, billed per execution. */
export const AppPlan = Azure.Web.AppServicePlan("FnAppPlan", { sku: "FC1" });

/** Host storage (AzureWebJobsStorage), deployment packages, and test data. */
export const AppStorage = Azure.Storage.StorageAccount("FnAppStorage");

const container = (id: string) =>
  Effect.gen(function* () {
    const account = yield* AppStorage;
    return yield* Azure.Storage.BlobContainer(id, { storageAccount: account.storageAccountName });
  });

/** Where Flex Consumption keeps the deployment package. */
export const AppReleases = container("FnAppReleases");
/** Where every handler records that it ran (`<source>/<id>`). */
export const AppResults = container("FnAppResults");
/** Uploads here fire the blob-created source. */
export const AppUploads = container("FnAppUploads");

/** Consumed by the queue trigger. */
export const AppJobs = Effect.gen(function* () {
  const account = yield* AppStorage;
  return yield* Azure.Storage.Queue("FnAppJobs", { storageAccount: account.storageAccountName });
});

const text = (body: string, status = 200) => HttpServerResponse.text(body, { status });

/** Answer `{ ok, result }`, or `{ ok: false, error }` with a 500 so callers retry. */
const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
  effect.pipe(
    Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
    Effect.catchCause((cause) =>
      HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
    ),
  );

const idOf = (body: unknown) => (body as { id?: unknown } | undefined)?.id;

/**
 * Effect-native `Azure.Web.FunctionApp` on a Flex Consumption plan the
 * fixture declares: `fetch`, a timer, a Storage queue trigger, a
 * blob-created trigger, and blob/queue bindings. Each trigger handler
 * writes `<source>/<id>` to {@link AppResults}; tests read it back with
 * `GET /result?key=…`.
 */
export default class EffectFunctionApp extends Azure.Web.FunctionApp<EffectFunctionApp>()(
  "EffectFunctionApp",
  Effect.gen(function* () {
    const plan = yield* AppPlan;
    const account = yield* AppStorage;
    const releases = yield* AppReleases;
    return {
      main: import.meta.url,
      // TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
      build: { input: { plugins: [distilledFromSource] } },
      serverFarmId: plan.appServicePlanId,
      hostStorageAccountId: account.storageAccountId,
      flexConsumption: {
        deploymentStorageUrl: Output.interpolate`${account.primaryEndpoints.blob}${releases.containerName}`,
        deploymentStorageAuthentication: { type: "SystemAssignedIdentity" as const },
        maximumInstanceCount: 40,
      },
      env: {
        GREETING: Config.String("AZURE_FNAPP_EFFECT_GREETING").pipe(Config.withDefault("hello")),
      },
      tags: { fixture: "effect-function-app" },
    };
  }),
  Effect.gen(function* () {
    const resultsContainer = yield* AppResults;
    const uploadsContainer = yield* AppUploads;
    const jobsQueue = yield* AppJobs;
    const results = yield* Azure.Storage.BlobContainerReadWrite(resultsContainer);
    const uploads = yield* Azure.Storage.BlobContainerWrite(uploadsContainer);
    const jobs = yield* Azure.Storage.QueueSend(jobsQueue);

    const record = (key: string, value: unknown) =>
      results
        .put(key, JSON.stringify(value), { contentType: "application/json" })
        .pipe(Effect.asVoid, Effect.orDie);

    yield* Azure.Functions.schedule("minutely", "0 * * * * *", (run) =>
      record("timer/last", { at: new Date().toISOString(), isPastDue: run.isPastDue }),
    );
    yield* Azure.Storage.consumeQueueMessages(AppJobs, (message) =>
      record(`queue/${idOf(message.body)}`, { dequeueCount: message.dequeueCount }),
    );
    yield* Azure.Storage.consumeBlobCreated(AppUploads, { prefix: "blob/" }, (event) =>
      record(`blob/${event.blobName.slice("blob/".length)}`, { url: event.url }),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const id = url.searchParams.get("id") ?? "";
        const key = url.searchParams.get("key") ?? "";
        switch (url.pathname) {
          case "/hello":
            return text(`${process.env.GREETING ?? "missing"} from a function app`);
          case "/result": {
            const found = yield* results.get(key).pipe(Effect.orDie);
            return found === undefined ? text("missing", 404) : text(found.text());
          }
          case "/blob":
            return yield* respond(
              Effect.gen(function* () {
                yield* results.put(key, url.searchParams.get("value") ?? "", {
                  contentType: "text/plain",
                });
                const blob = yield* results.get(key);
                return { text: blob?.text() };
              }),
            );
          case "/upload":
            return yield* respond(uploads.put(key, "uploaded"));
          case "/queue/send":
            return yield* respond(jobs.send(JSON.stringify({ id })));
          default:
            return text("not found", 404);
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Azure.Functions.StorageQueueEventSource,
        Azure.Functions.BlobCreatedEventSource,
        Azure.Storage.BlobContainerWriteHttp,
        Azure.Storage.BlobContainerReadWriteHttp,
        Azure.Storage.QueueSendHttp,
      ),
    ),
  ),
) {}
