import { BunHttpServer, HttpServer } from "alchemy/Http";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

// Serves the same `{ fetch }`-style handler the container bootstraps serve,
// through the same `BunHttpServer()` layer. The handler reads the whole body.
const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest;
  const body = yield* request.text;
  return HttpServerResponse.text(String(body.length));
});

// `MAX_REQUEST_BODY_SIZE` is picked up from the environment by `BunHttpServer()`.
// `BODY_LIMIT_OPTION` exercises the typed option instead.
const option = process.env.BODY_LIMIT_OPTION;

Effect.gen(function* () {
  const http = yield* HttpServer;
  yield* http.serve(handler);
  console.log("body-limit ready");
  yield* Effect.never;
}).pipe(
  Effect.provide(BunHttpServer(option === undefined ? {} : { maxRequestBodySize: Number(option) })),
  Effect.scoped,
  Effect.runPromise,
);
