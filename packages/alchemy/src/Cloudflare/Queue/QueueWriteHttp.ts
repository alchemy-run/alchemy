import * as queues from "@distilled.cloud/cloudflare/queues";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { authorizeWith } from "../HttpClientUtils.ts";
import {
  makeHttpQueueBinding,
  makeQueueHttpScope,
  toQueueSendError,
  type QueueHttpToken,
} from "./QueueHttp.ts";
import {
  QueueSendError,
  type QueueSendMessage,
  type QueueSendOptions,
} from "./QueueTypes.ts";
import { QueueWrite, type WriteQueueClient } from "./QueueWrite.ts";

/**
 * HTTP-backed implementation of the {@link QueueWrite} service.
 *
 * It creates a scoped {@link AccountApiToken} with the `Queues Write`
 * permission and pushes messages via the Cloudflare Queues HTTP API.
 */
export const WriteQueueHttp = Layer.effect(
  QueueWrite,
  Effect.suspend(() =>
    makeHttpQueueBinding({
      permissionGroups: ["Queues Write"],
      makeClient: makeWriteQueueHttpClient,
    }),
  ),
);

/** Encode a message body for the HTTP push API. */
const encodeBody = (
  body: unknown,
  contentType: "json" | "text" | undefined,
): string =>
  contentType === "text"
    ? typeof body === "string"
      ? body
      : String(body)
    : JSON.stringify(body);

/** Build the producer client over the Queues HTTP push API. */
export const makeWriteQueueHttpClient = (
  token: QueueHttpToken,
  queueId: Effect.Effect<string>,
): WriteQueueClient => {
  const authorize = authorizeWith(token);
  const scope = makeQueueHttpScope(token, queueId);

  const push = (message: QueueSendMessage) =>
    scope.pipe(
      Effect.flatMap(({ accountId, queueId }) =>
        authorize(
          queues.pushMessage({
            accountId,
            queueId,
            body: encodeBody(message.body, message.contentType),
            contentType: message.contentType ?? "json",
          }),
        ),
      ),
      Effect.mapError(toQueueSendError),
      Effect.asVoid,
    );

  return {
    raw: Effect.die(
      new QueueSendError({
        message:
          "Queue HTTP client does not expose a native Queue binding; use send/sendBatch.",
        cause: new Error("unsupported"),
      }),
    ),
    send: (body: unknown, options?: QueueSendOptions) =>
      push({ body, contentType: options?.contentType }),
    sendBatch: (messages: ReadonlyArray<QueueSendMessage>) =>
      Effect.forEach(messages, push, { discard: true }),
  };
};
