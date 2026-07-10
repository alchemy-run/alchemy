import * as Lambda from "@/AWS/Lambda";
import * as SQS from "@/AWS/SQS";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

// Shared Lambda fixture hosting every SQS message-plane binding, one HTTP
// route per operation (see test/AWS/DynamoDB/handler.ts for the pattern).
export class SQSTestFunction extends Lambda.Function<Lambda.Function>()(
  "SQSTestFunction",
) {}

export default SQSTestFunction.make(
  {
    main,
    url: true,
    // The /receive route long-polls SQS (WaitTimeSeconds up to 2s); AWS's 3s
    // default function timeout intermittently kills the invocation AFTER SQS
    // has consumed the message server-side, trapping it invisible for the
    // queue's 30s visibility window while the caller only sees a 500.
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const queue = yield* SQS.Queue("BindingsQueue");

    const sendMessage = yield* SQS.SendMessage(queue);
    const sendMessageBatch = yield* SQS.SendMessageBatch(queue);
    const receiveMessage = yield* SQS.ReceiveMessage(queue);
    const deleteMessage = yield* SQS.DeleteMessage(queue);
    const deleteMessageBatch = yield* SQS.DeleteMessageBatch(queue);
    const queueUrl = yield* queue.queueUrl;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        yield* Effect.logInfo(`Request: ${request.method} ${pathname}`);

        if (request.method === "GET" && pathname === "/ready") {
          return yield* HttpServerResponse.json({
            ok: true,
            queueUrl: yield* queueUrl,
          });
        }

        if (request.method === "POST" && pathname === "/send") {
          const body = (yield* request.json) as unknown as {
            messageBody: string;
          };
          const result = yield* sendMessage({
            MessageBody: body.messageBody,
          });
          return yield* HttpServerResponse.json({
            messageId: result.MessageId,
          });
        }

        if (request.method === "POST" && pathname === "/send-batch") {
          const body = (yield* request.json) as unknown as {
            entries: { id: string; messageBody: string }[];
          };
          const result = yield* sendMessageBatch({
            Entries: body.entries.map((entry) => ({
              Id: entry.id,
              MessageBody: entry.messageBody,
            })),
          });
          return yield* HttpServerResponse.json({
            successful: (result.Successful ?? []).map((s) => ({
              id: s.Id,
              messageId: s.MessageId,
            })),
            failed: (result.Failed ?? []).map((f) => ({
              id: f.Id,
              code: f.Code,
            })),
          });
        }

        if (request.method === "POST" && pathname === "/receive") {
          const body = (yield* request.json) as unknown as {
            maxNumberOfMessages?: number;
            waitTimeSeconds?: number;
            visibilityTimeout?: number;
          };
          const result = yield* receiveMessage({
            MaxNumberOfMessages: body.maxNumberOfMessages ?? 10,
            WaitTimeSeconds: body.waitTimeSeconds ?? 2,
            ...(body.visibilityTimeout !== undefined
              ? { VisibilityTimeout: body.visibilityTimeout }
              : {}),
          });
          return yield* HttpServerResponse.json({
            messages: (result.Messages ?? []).map((message) => ({
              messageId: message.MessageId,
              body: message.Body,
              receiptHandle: message.ReceiptHandle,
            })),
          });
        }

        if (request.method === "POST" && pathname === "/delete") {
          const body = (yield* request.json) as unknown as {
            receiptHandle: string;
          };
          yield* deleteMessage({ ReceiptHandle: body.receiptHandle });
          return yield* HttpServerResponse.json({ success: true });
        }

        if (request.method === "POST" && pathname === "/delete-batch") {
          const body = (yield* request.json) as unknown as {
            entries: { id: string; receiptHandle: string }[];
          };
          const result = yield* deleteMessageBatch({
            Entries: body.entries.map((entry) => ({
              Id: entry.id,
              ReceiptHandle: entry.receiptHandle,
            })),
          });
          return yield* HttpServerResponse.json({
            successful: (result.Successful ?? []).map((s) => s.Id),
            failed: (result.Failed ?? []).map((f) => ({
              id: f.Id,
              code: f.Code,
            })),
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        SQS.SendMessageHttp,
        SQS.SendMessageBatchHttp,
        SQS.ReceiveMessageHttp,
        SQS.DeleteMessageHttp,
        SQS.DeleteMessageBatchHttp,
      ),
    ),
  ),
);
