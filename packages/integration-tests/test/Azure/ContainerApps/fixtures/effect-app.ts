import * as Azure from "@alchemy.run/azure";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import {
  APP_LOCATION,
  AppAudit,
  AppEnvironment,
  AppEvents,
  AppJobs,
  AppOrders,
  AppResults,
} from "./app-resources.ts";
import { distilledFromSource } from "./distilled-source.ts";

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
 * Effect-native Container App on a managed identity: `fetch`, one handler
 * per event source, and a schedule. Each handler writes `<source>/<id>` to
 * {@link AppResults} through `BlobContainerReadWrite`; tests read it back
 * with `GET /result?key=…`. One replica stays up so the consumer loops and
 * the schedule run between requests.
 */
export default class EffectApp extends Azure.ContainerApps.ContainerApp<EffectApp>()(
  "EffectApp",
  Effect.gen(function* () {
    const environment = yield* AppEnvironment;
    return {
      main: import.meta.url,
      location: APP_LOCATION,
      environmentId: environment.environmentId,
      cpu: 0.25,
      memory: "0.5Gi",
      template: { scale: { minReplicas: 1, maxReplicas: 1 } },
      // TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
      build: { input: { plugins: [distilledFromSource] } },
      env: {
        GREETING: Config.String("AZURE_CA_EFFECT_GREETING").pipe(Config.withDefault("hello")),
      },
    };
  }),
  Effect.gen(function* () {
    const resultsContainer = yield* AppResults;
    const jobsQueue = yield* AppJobs;
    const ordersQueue = yield* AppOrders;
    const eventsTopic = yield* AppEvents;
    const results = yield* Azure.Storage.BlobContainerReadWrite(resultsContainer);
    const jobs = yield* Azure.Storage.QueueSend(jobsQueue);
    const orders = yield* Azure.ServiceBus.QueueSend(ordersQueue);
    const events = yield* Azure.ServiceBus.TopicWrite(eventsTopic);

    const record = (key: string, value: unknown) =>
      results
        .put(key, JSON.stringify(value), { contentType: "application/json" })
        .pipe(Effect.asVoid, Effect.orDie);

    yield* Azure.Storage.consumeQueueMessages(AppJobs, (message) =>
      record(`queue/${idOf(message.body)}`, { dequeueCount: message.dequeueCount }),
    );
    yield* Azure.ServiceBus.consumeQueueMessages(AppOrders, (message) =>
      record(`servicebus-queue/${idOf(message.body)}`, { deliveryCount: message.deliveryCount }),
    );
    yield* Azure.ServiceBus.consumeSubscriptionMessages(AppAudit, (message) =>
      record(`servicebus-topic/${idOf(message.body)}`, { messageId: message.messageId }),
    );
    yield* Azure.ContainerApps.appSchedule("minutely", "* * * * *", (run) =>
      record("schedule/last", { at: new Date().toISOString(), scheduledTime: run.scheduledTime }),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const id = url.searchParams.get("id") ?? "";
        const key = url.searchParams.get("key") ?? "";
        switch (url.pathname) {
          case "/hello":
            return text(`${process.env.GREETING ?? "missing"} from container apps`);
          case "/result": {
            const found = yield* results.get(key).pipe(Effect.orDie);
            return found === undefined ? text("missing", 404) : text(found.text());
          }
          case "/queue/send":
            return yield* respond(jobs.send(JSON.stringify({ id })));
          case "/servicebus/queue":
            return yield* respond(orders.send({ id }));
          case "/servicebus/topic":
            return yield* respond(events.send({ id }));
          case "/blob/write":
            return yield* respond(
              Effect.map(results.put(key, url.searchParams.get("value") ?? ""), ({ etag }) => ({
                etag,
              })),
            );
          default:
            return text("not found", 404);
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Azure.ContainerApps.AppStorageQueueEventSource,
        Azure.ContainerApps.AppServiceBusQueueEventSource,
        Azure.ContainerApps.AppServiceBusSubscriptionEventSource,
        Azure.Storage.BlobContainerReadWriteHttp,
        Azure.Storage.QueueSendHttp,
        Azure.ServiceBus.QueueSendHttp,
        Azure.ServiceBus.TopicWriteHttp,
      ),
    ),
  ),
) {}
