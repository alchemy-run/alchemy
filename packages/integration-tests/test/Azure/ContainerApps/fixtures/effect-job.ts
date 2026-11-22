import * as Azure from "@alchemy.run/azure";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { distilledFromSource } from "./distilled-source.ts";
import { JOB_LOCATION, JobEnv, JobOrders, JobResults, JobWork } from "./job-resources.ts";

/** Execution name Container Apps sets in every job replica. */
export const executionName = Effect.sync(
  () => process.env.CONTAINER_APP_JOB_EXECUTION_NAME ?? "unknown",
);

/**
 * Effect-native manual job: each execution records `effect/<execution>` in
 * `JobResults` (through `BlobContainerReadWrite`), then sends
 * `{ id: <execution> }` to the Storage queue and the Service Bus queue the
 * event-driven jobs consume. It gets its own registry (the default path).
 */
export default class EffectJob extends Azure.ContainerApps.Job<EffectJob>()(
  "EffectJob",
  Effect.gen(function* () {
    const env = yield* JobEnv;
    return {
      main: import.meta.url,
      location: JOB_LOCATION,
      environmentId: env.environmentId,
      // TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
      build: { input: { plugins: [distilledFromSource] } },
      cpu: 0.25,
      memory: "0.5Gi",
      configuration: { triggerType: "Manual", replicaTimeout: 300, replicaRetryLimit: 0 },
      env: {
        GREETING: Config.String("AZURE_JOB_EFFECT_GREETING").pipe(Config.withDefault("hello")),
      },
    };
  }),
  Effect.gen(function* () {
    const resultsContainer = yield* JobResults;
    const workQueue = yield* JobWork;
    const ordersQueue = yield* JobOrders;
    const results = yield* Azure.Storage.BlobContainerReadWrite(resultsContainer);
    const work = yield* Azure.Storage.QueueSend(workQueue);
    const orders = yield* Azure.ServiceBus.QueueSend(ordersQueue);
    return {
      run: Effect.gen(function* () {
        const id = yield* executionName;
        const report = yield* Effect.sync(() =>
          JSON.stringify({ greeting: process.env.GREETING, node: process.versions.node }),
        );
        yield* results.put(`effect/${id}`, report, { contentType: "application/json" });
        yield* work.send(JSON.stringify({ id }));
        yield* orders.send({ id }, { messageId: id });
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Azure.Storage.BlobContainerReadWriteHttp,
        Azure.Storage.QueueSendHttp,
        Azure.ServiceBus.QueueSendHttp,
      ),
    ),
  ),
) {}
