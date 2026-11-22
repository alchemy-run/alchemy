import * as Azure from "@alchemy.run/azure";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { distilledFromSource } from "./distilled-source.ts";
import { JobOrders, JobResults, JobWork, sharedJobProps } from "./job-resources.ts";

const idOf = (body: unknown) => (body as { id?: unknown } | undefined)?.id;

/** Every-minute cron of `ScheduleJob`. */
export const SCHEDULE = "* * * * *";

const recorder = Effect.gen(function* () {
  const container = yield* JobResults;
  const results = yield* Azure.Storage.BlobContainerReadWrite(container);
  return (key: string, value: unknown) =>
    results
      .put(key, JSON.stringify(value), { contentType: "application/json" })
      .pipe(Effect.asVoid, Effect.orDie);
});

const props = (main: string) =>
  Effect.map(sharedJobProps, (shared) => ({
    ...shared,
    main,
    // TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
    build: { input: { plugins: [distilledFromSource] } },
    configuration: { triggerType: "Manual", replicaTimeout: 300, replicaRetryLimit: 0 },
  }));

/**
 * Event-driven job on the Storage queue: records `queue/<id>` for every
 * message `EffectJob` sends.
 */
export class QueueJob extends Azure.ContainerApps.Job<QueueJob>()(
  "QueueJob",
  props(import.meta.url),
  Effect.gen(function* () {
    const record = yield* recorder;
    yield* Azure.Storage.consumeQueueMessages(JobWork, (message) =>
      record(`queue/${idOf(message.body)}`, { dequeueCount: message.dequeueCount }),
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Azure.ContainerApps.JobStorageQueueEventSource,
        Azure.Storage.BlobContainerReadWriteHttp,
      ),
    ),
  ),
) {}

/**
 * Event-driven job on the Service Bus queue: records `servicebus/<id>` for
 * every message `EffectJob` sends.
 */
export class ServiceBusJob extends Azure.ContainerApps.Job<ServiceBusJob>()(
  "ServiceBusJob",
  Effect.map(props(import.meta.url), (p) => ({ ...p, handler: "ServiceBusJob" })),
  Effect.gen(function* () {
    const record = yield* recorder;
    yield* Azure.ServiceBus.consumeQueueMessages(JobOrders, (message) =>
      record(`servicebus/${idOf(message.body)}`, { deliveryCount: message.deliveryCount }),
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Azure.ContainerApps.JobServiceBusQueueEventSource,
        Azure.Storage.BlobContainerReadWriteHttp,
      ),
    ),
  ),
) {}

/** Scheduled job: every execution records `schedule/<execution>`. */
export class ScheduleJob extends Azure.ContainerApps.Job<ScheduleJob>()(
  "ScheduleJob",
  Effect.map(props(import.meta.url), (p) => ({ ...p, handler: "ScheduleJob" })),
  Effect.gen(function* () {
    const record = yield* recorder;
    yield* Azure.ContainerApps.schedule(
      SCHEDULE,
      Effect.gen(function* () {
        const id = yield* Effect.sync(
          () => process.env.CONTAINER_APP_JOB_EXECUTION_NAME ?? "unknown",
        );
        const at = yield* Effect.sync(() => new Date().toISOString());
        yield* record(`schedule/${id}`, { at });
      }),
    );
  }).pipe(Effect.provide(Azure.Storage.BlobContainerReadWriteHttp)),
) {}

/** `QueueJob` is the default export `main` resolves; the others name their export. */
export default QueueJob;
