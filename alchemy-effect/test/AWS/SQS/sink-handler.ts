import * as AWS from "@/AWS";
import * as Http from "@/Http";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "sink-handler.ts");

export const QueueSinkFixture = Effect.gen(function* () {
  const queue = yield* AWS.SQS.Queue("QueueSinkQueue");

  const apiFunction = yield* AWS.Lambda.Function(
    "QueueSinkFunction",
    Effect.gen(function* () {
      const sink = yield* AWS.SQS.QueueSink.bind(queue);

      yield* Http.serve(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest;
          yield* Console.log(request);
          const pathname = new URL(request.originalUrl).pathname;

          if (request.method === "GET" && pathname === "/ready") {
            return yield* HttpServerResponse.json({ ok: true });
          }

          if (request.method === "POST" && pathname === "/sink") {
            const body = (yield* request.json) as { messages: string[] };

            yield* Stream.fromIterable(body.messages).pipe(Stream.run(sink));

            return yield* HttpServerResponse.json({
              ok: true,
              count: body.messages.length,
            });
          }

          return yield* HttpServerResponse.json(
            { error: "Not found", method: request.method, pathname },
            { status: 404 },
          );
        }).pipe(
          Effect.tapError(Console.log),
          Effect.tap(Console.log),
          Effect.catch(() =>
            Effect.succeed(
              HttpServerResponse.text("Internal server error", { status: 500 }),
            ),
          ),
        ),
      );

      return {
        main,
        url: true,
      } as const satisfies AWS.Lambda.FunctionProps;
    }).pipe(
      Effect.provide(
        Layer.provideMerge(
          Layer.mergeAll(AWS.Lambda.HttpServer, AWS.SQS.QueueSinkLive),
          Layer.mergeAll(AWS.SQS.SendMessageBatchLive),
        ),
      ),
    ),
  );

  return {
    queue,
    apiFunction,
  };
});

export default QueueSinkFixture.pipe(
  Effect.map(({ apiFunction }) => apiFunction),
);
