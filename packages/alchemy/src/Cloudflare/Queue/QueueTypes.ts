import * as Data from "effect/Data";

/** Options accepted by a single {@link WriteQueueClient.send} call. */
export interface QueueSendOptions {
  contentType?: "json" | "text";
}

/** A single message handed to {@link WriteQueueClient.sendBatch}. */
export interface QueueSendMessage {
  body: unknown;
  contentType?: "json" | "text";
}

export class QueueSendError extends Data.TaggedError("QueueSendError")<{
  message: string;
  cause?: unknown;
}> {}
