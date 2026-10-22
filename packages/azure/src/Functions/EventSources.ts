import * as Effect from "effect/Effect";
import { Function, type TriggerInvocation } from "./Function.ts";

/** A timer invocation (`TimerInfo` from the Functions host). */
export interface TimerInvocation {
  /** Raw timer info (`ScheduleStatus`, `IsPastDue`). */
  timer: unknown;
  metadata: Record<string, unknown>;
}

/**
 * Run `handler` on a NCRONTAB schedule (six fields, seconds first) via a
 * native `timerTrigger` function on the host's function app. The Functions
 * host fires the timer and POSTs the invocation to the program, so no
 * polling loop runs inside the runtime.
 *
 * ### Scheduling work
 * **Example:** Every five minutes
 * ```typescript
 * yield* Azure.Functions.schedule("cleanup", "0 *\/5 * * * *", () =>
 *   Effect.log("cleanup"),
 * );
 * ```
 *
 * @binding
 * @category Functions
 */
export const schedule = <Req = never>(
  name: string,
  cron: string,
  handler: (invocation: TimerInvocation) => Effect.Effect<void, never, Req>,
) =>
  Effect.gen(function* () {
    const host = yield* Function;
    const binding = { type: "timerTrigger", schedule: cron };
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      yield* host.bind(`Azure.Functions.Timer(${name})`, {
        functions: [{ name, binding }],
      });
    }
    yield* host.trigger(name, binding, (inv: TriggerInvocation) =>
      handler({ timer: inv.Data.trigger, metadata: inv.Metadata }),
    );
  });

/** A Storage Queue message delivered by a `queueTrigger`. */
export interface QueueMessage {
  /** Message body (JSON-decoded by the host when it is JSON). */
  body: unknown;
  /** Trigger metadata (`Id`, `DequeueCount`, `InsertionTime`, …). */
  metadata: Record<string, unknown>;
}

export interface StorageQueueProps {
  /** Name of the queue to consume. */
  queueName: string;
  /**
   * Name of the storage account holding the queue. The host connects with
   * the function app's managed identity (identity-based connection
   * `{name}__queueServiceUri`), which needs `Storage Queue Data Message
   * Processor` (or Contributor) on the account.
   */
  storageAccountName: string;
}

/**
 * Consume an Azure Storage Queue through a native `queueTrigger` function.
 * The Functions host dequeues, retries failed messages up to `maxDequeueCount`
 * and moves poison messages to `{queue}-poison`; the program only handles one
 * message per invocation. A failing handler defects so the host retries it.
 *
 * ### Consuming messages
 * **Example:** Log each queue message
 * ```typescript
 * yield* Azure.Functions.consumeStorageQueue(
 *   "orders",
 *   { queueName: "orders", storageAccountName: account.accountName },
 *   (message) => Effect.log(message.body),
 * );
 * ```
 *
 * @binding
 * @category Functions
 */
export const consumeStorageQueue = <Req = never>(
  name: string,
  props: StorageQueueProps,
  handler: (message: QueueMessage) => Effect.Effect<void, never, Req>,
) =>
  Effect.gen(function* () {
    const host = yield* Function;
    const connection = `ALCHEMY_QUEUE_${name.replaceAll(/[^a-zA-Z0-9]/g, "_")}`;
    const binding = {
      type: "queueTrigger",
      queueName: props.queueName,
      connection,
    };
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      yield* host.bind(`Azure.Functions.StorageQueue(${name})`, {
        env: {
          [`${connection}__queueServiceUri`]: `https://${props.storageAccountName}.queue.core.windows.net`,
        },
        functions: [{ name, binding }],
      });
    }
    yield* host.trigger(name, binding, (inv: TriggerInvocation) =>
      handler({ body: inv.Data.trigger, metadata: inv.Metadata }),
    );
  });
