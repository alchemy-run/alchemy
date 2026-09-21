import type {
  NativeQueue,
  QueueSendOptions,
  QueueSendMessage,
} from "./QueueTypes.ts";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Queue, QueueConfigurationError } from "./Queue.ts";

/** Default delivery policy on a native producer binding. */
export interface WriteQueueOptions {
  /** Default delivery delay in seconds, 0–86400. Per-message delays override it. */
  deliveryDelay?: number;
}

/** Options for one message or a batch's default delivery delay. */
export type SendOptions = QueueSendOptions;

/** One message in a batch; its delay overrides the batch default. */
export type SendMessage = QueueSendMessage;

/** The producer call failed; retry overload errors with a bounded policy. */
export class SendError extends Data.TaggedError("Celld.Queues.SendError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface WriteQueueClient {
  /** Native producer binding. */
  readonly raw: Effect.Effect<NativeQueue, SendError, RuntimeContext>;
  /** Enqueue a single message. */
  send(
    body: unknown,
    options?: SendOptions,
  ): Effect.Effect<void, SendError, RuntimeContext>;
  /** Enqueue up to 100 messages with optional batch-wide delivery delay. */
  sendBatch(
    messages: ReadonlyArray<SendMessage>,
    options?: Pick<SendOptions, "delaySeconds">,
  ): Effect.Effect<void, SendError, RuntimeContext>;
}

/**
 * Bind a Celld queue's native producer. Provide `WriteQueueBinding` on the Worker.
 * There is no HTTP or pull implementation.
 *
 * ### Send messages
 * **Example:** Delayed delivery
 * ```typescript
 * const writer = yield* Celld.Queues.WriteQueue(jobs);
 * // Inside a request handler:
 * yield* writer.send({ job: "refresh" }, { delaySeconds: 5 });
 * ```
 *
 * @binding
 * @product Celld
 */
export interface WriteQueue extends Binding.Service<
  WriteQueue,
  "Celld.Queues.WriteQueue",
  (
    queue: Queue,
    options?: WriteQueueOptions,
  ) => Effect.Effect<WriteQueueClient, QueueConfigurationError>
> {}

export const WriteQueue = Binding.Service<WriteQueue>(
  "Celld.Queues.WriteQueue",
);
