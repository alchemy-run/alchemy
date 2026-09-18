import * as Effect from "effect/Effect";
import * as Namespace from "../../Namespace.ts";
import * as DurationUtil from "../../Util/Duration.ts";
import { Worker } from "../Worker.ts";
import { storageBinding } from "../KV/StorageBinding.ts";
import type { CelldQueueConsumer } from "../DeploymentConfig.ts";
import type { Queue } from "./Queue.ts";
import { QueueConfigurationError } from "./Queue.ts";

/** Settings for a queue's single push consumer attachment. */
export interface ConsumerSettings {
  /** Messages per batch, 1–100. @default 10 */
  batchSize?: number;
  /** Concurrent invocations, 1–250. */
  maxConcurrency?: number;
  /** Retries before discarding or dead-lettering, 0–100. @default 3 */
  maxRetries?: number;
  /** Partial batch flush timeout, 0–60000 milliseconds, rounded up to seconds. */
  maxWaitTimeMs?: number;
  /** Retry delay, 0–86400 seconds. */
  retryDelay?: number;
}

/** A consumer declaration is attached to the ambient Worker, never by HTTP API. */
export interface ConsumerProps {
  /** The queue identity, resolved in this Worker's fleet. */
  queue: Queue;
  /** Push delivery settings. */
  settings?: ConsumerSettings;
  /** Queue receiving messages after retries are exhausted; must share the fleet. */
  deadLetterQueue?: Queue;
}

/** Convert Cloudflare-shaped settings to Celld deployment fields. @internal */
export const toQueueConsumer = (
  settings: ConsumerSettings = {},
): Omit<CelldQueueConsumer, "queue" | "deadLetterQueue"> => ({
  maxBatchSize: settings.batchSize,
  maxBatchTimeout: DurationUtil.toSeconds(settings.maxWaitTimeMs),
  maxConcurrency: settings.maxConcurrency,
  maxRetries: settings.maxRetries,
  retryDelay: settings.retryDelay,
});

/** Validate the deploy-time consumer settings before serialization. @internal */
export const validateConsumerSettings = (settings: ConsumerSettings = {}) =>
  Effect.gen(function* () {
    const limits = [
      ["batchSize", settings.batchSize, 1, 100],
      ["maxConcurrency", settings.maxConcurrency, 1, 250],
      ["maxRetries", settings.maxRetries, 0, 100],
      ["maxWaitTimeMs", settings.maxWaitTimeMs, 0, 60000],
      ["retryDelay", settings.retryDelay, 0, 86400],
    ] as const;
    for (const [key, value, min, max] of limits) {
      if (
        value !== undefined &&
        (!Number.isInteger(value) || value < min || value > max)
      ) {
        return yield* Effect.fail(
          new QueueConfigurationError({
            message: `Celld consumer ${key} must be an integer between ${min} and ${max}`,
          }),
        );
      }
    }
  });

/**
 * Attach a queue consumer to the current Worker. Application publication manages
 * attachments separately from script pointers; publication is not atomic.
 * Removing this declaration detaches delivery but retains queue contents.
 * This is Worker metadata, not a separately managed HTTP API resource.
 *
 * ### Attach a push consumer
 * **Example:** Consumer metadata for a separately registered listener
 * ```typescript
 * yield* Celld.Queues.Consumer("JobsConsumer", { queue: jobs, settings: { batchSize: 10 } });
 * ```
 *
 * @binding
 * @product Celld
 */
export const Consumer = Effect.fn(function* (id: string, props: ConsumerProps) {
  const host = yield* Worker;
  yield* validateConsumerSettings(props.settings);
  if (!globalThis.__ALCHEMY_RUNTIME__) {
    yield* claimConsumer(host, props.queue.LogicalId);
    yield* Namespace.push(
      host.LogicalId,
      host.bind(id, {
        storageBindings: [
          storageBinding(props.queue),
          ...(props.deadLetterQueue
            ? [storageBinding(props.deadLetterQueue)]
            : []),
        ],
        queueConsumers: [
          {
            queue: props.queue.queueName,
            ...toQueueConsumer(props.settings),
            deadLetterQueue: props.deadLetterQueue?.queueName,
          },
        ],
      }),
    );
  }
});

const consumers = new WeakMap<object, Set<string>>();

/** Reject duplicate declarations before binding metadata can overwrite them. @internal */
export const claimConsumer = (host: object, queue: string) =>
  Effect.gen(function* () {
    const declarations = consumers.get(host) ?? new Set<string>();
    if (declarations.has(queue)) {
      return yield* Effect.fail(
        new QueueConfigurationError({
          message: `Queue '${queue}' has multiple consumer declarations on this Worker; declare settings and the listener together with consumeQueueMessages.`,
        }),
      );
    }
    declarations.add(queue);
    consumers.set(host, declarations);
  });
