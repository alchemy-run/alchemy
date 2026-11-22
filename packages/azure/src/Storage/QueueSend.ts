import type { AzureOpError } from "@distilled.cloud/azure";
import type * as queues from "@distilled.cloud/azure/storage-queue";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Queue } from "./Queue.ts";

/**
 * Error of every queue client operation: the typed
 * `@distilled.cloud/azure/storage-queue` errors plus {@link AzureOpError}.
 */
export type StorageQueueError =
  | queues.MessageNotFound
  | queues.PopReceiptMismatch
  | queues.QueueAlreadyExists
  | queues.StorageAuthenticationFailed
  | queues.StorageAuthorizationFailure
  | queues.StorageBeingDeleted
  | queues.StorageResourceAlreadyExists
  | AzureOpError;

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
  ): Effect.Effect<StorageQueueSendResult, StorageQueueError, RuntimeContext>;
}

/**
 * Send messages to an Azure Storage queue from any host.
 *
 * Binding assigns **Storage Queue Data Message Sender** on the queue only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`).
 * Provide {@link QueueSendHttp}.
 *
 * ### Sending Messages
 * **Example:** Enqueue a job
 * ```typescript
 * // init
 * const jobs = yield* Azure.Storage.QueueSend(queue);
 *
 * // runtime
 * yield* jobs.send(JSON.stringify({ jobId }));
 * // …provided with Effect.provide(Azure.Storage.QueueSendHttp)
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
