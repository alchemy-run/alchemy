import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type {
  AzureDataPlaneError,
  AzureManagedIdentityError,
} from "../Binding.ts";
import type { Queue } from "./Queue.ts";

export interface StorageQueueSendOptions {
  /** Seconds before the message becomes visible. @default 0 */
  visibilityTimeoutSeconds?: number;
  /** Seconds the message lives; `-1` never expires. @default 7 days */
  timeToLiveSeconds?: number;
}

export interface StorageQueueSendResult {
  messageId: string | undefined;
  popReceipt: string | undefined;
  insertionTime: string | undefined;
}

/** Send-only client for one storage queue. */
export interface SendStorageQueueClient {
  /** Enqueue a text message (max 64 KiB). */
  send(
    message: string,
    options?: StorageQueueSendOptions,
  ): Effect.Effect<
    StorageQueueSendResult,
    AzureDataPlaneError | AzureManagedIdentityError,
    RuntimeContext
  >;
}

/**
 * Send messages to an Azure Storage queue from a Container App or Function
 * App.
 *
 * Binding grants the host's system-assigned managed identity
 * **Storage Queue Data Message Sender** on the queue only. Provide
 * {@link QueueSendHttp}.
 *
 * ### Sending Messages
 * **Example:** Enqueue a job
 * ```typescript
 * // init
 * const jobs = yield* Azure.Storage.QueueSend(queue);
 *
 * // runtime
 * yield* jobs.send(JSON.stringify({ jobId }));
 * ```
 *
 * @binding
 * @category Storage
 */
export interface QueueSend extends Binding.Service<
  QueueSend,
  "Azure.Storage.QueueSend",
  (queue: Queue) => Effect.Effect<SendStorageQueueClient>
> {}

export const QueueSend = Binding.Service<QueueSend>("Azure.Storage.QueueSend");
