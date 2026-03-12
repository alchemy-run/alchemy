import * as AWS from "alchemy-effect/AWS";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export const HttpServer = Effect.fn(function* (queue: AWS.SQS.Queue) {
  const sendMessage = yield* AWS.SQS.SendMessage.bind(queue);

  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return yield* HttpServerResponse.json({
        ok: true,
        routes: ["GET /", "GET /enqueue?message=hello"],
      });
    }

    if (request.method === "GET" && url.pathname === "/enqueue") {
      const message = url.searchParams.get("message") ?? "hello from EC2";
      const body = JSON.stringify({
        message,
        enqueuedAt: new Date().toISOString(),
      });

      const result = yield* sendMessage({
        MessageBody: body,
      });

      return yield* HttpServerResponse.json({
        ok: true,
        message,
        messageId: result.MessageId,
      });
    }

    return HttpServerResponse.text("Not found", { status: 404 });
  }).pipe(
    Effect.catch(() =>
      Effect.succeed(
        HttpServerResponse.text("Internal server error", { status: 500 }),
      ),
    ),
  );
});
