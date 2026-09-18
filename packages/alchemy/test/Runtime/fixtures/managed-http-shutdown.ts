import { HttpServer, NodeHttpServer } from "alchemy/Http";
import { bootstrap } from "alchemy/Runtime/Bootstrap/Fly";
import { runProcess } from "alchemy/Runtime/Bootstrap/Process";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

const event = (message: string) => Effect.sync(() => console.log(message));

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest;
  if (request.url === "/health") return HttpServerResponse.text("ok");
  yield* Effect.addFinalizer(() => event("request finalized"));
  yield* event("request started");
  if (request.url === "/hang") return yield* Effect.never;
  if (request.url === "/stream" || request.url === "/stream-hang") {
    const body = Stream.fromArray(["first\n", "second\n", "last\n"]).pipe(
      Stream.mapEffect((chunk) =>
        Effect.sleep("300 millis").pipe(
          Effect.andThen(event(`chunk ${chunk.trim()}`)),
          Effect.andThen(Effect.sync(() => new TextEncoder().encode(chunk))),
        ),
      ),
    );
    return HttpServerResponse.stream(
      request.url === "/stream-hang"
        ? body.pipe(Stream.concat(Stream.fromEffect(Effect.never)))
        : body,
    );
  }
  yield* Effect.sleep("900 millis");
  yield* event("response ready");
  return HttpServerResponse.text("completed");
});

const program = Effect.gen(function* () {
  const server = yield* HttpServer;
  yield* server.serve(handler);
  yield* event("ready");
  yield* Effect.never;
});

const entrypoint = Effect.gen(function* () {
  yield* Effect.addFinalizer(() =>
    event("instance finalizing").pipe(
      Effect.andThen(
        process.env.HANG_FINALIZER === "1"
          ? Effect.never
          : Effect.sleep("40 millis"),
      ),
      Effect.andThen(event("instance finalized")),
    ),
  );
  return { RuntimeContext: { exports: Effect.succeed({ program }) } };
});

if (process.env.UNMANAGED_HOST === "1") {
  await runProcess(
    "Unmanaged service",
    program.pipe(Effect.provide(NodeHttpServer()), Effect.scoped),
  );
} else {
  await bootstrap(entrypoint);
}
