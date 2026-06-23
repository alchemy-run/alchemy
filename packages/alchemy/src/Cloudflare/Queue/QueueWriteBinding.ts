import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeQueueBinding, makeQueueHelpers } from "./QueueBinding.ts";
import type { QueueSendMessage, QueueSendOptions } from "./QueueTypes.ts";
import { QueueWrite, type WriteQueueClient } from "./QueueWrite.ts";

/**
 * Implementation of the {@link QueueWrite} service that uses a native Worker
 * queue binding.
 */
export const WriteQueueBinding = Layer.effect(
  QueueWrite,
  Effect.suspend(() => makeQueueBinding({ makeClient: makeWriteQueueClient })),
);

/** Build the producer client over a native Worker queue binding. */
export const makeWriteQueueClient = ({
  raw,
  use,
}: ReturnType<typeof makeQueueHelpers>): WriteQueueClient => ({
  raw,
  send: (body: unknown, options?: QueueSendOptions) =>
    use((q) => q.send(body, options)),
  sendBatch: (messages: ReadonlyArray<QueueSendMessage>) =>
    use((q) =>
      q.sendBatch(
        messages.map((m) => ({
          body: m.body,
          ...(m.contentType ? { contentType: m.contentType } : {}),
        })),
      ),
    ),
});
