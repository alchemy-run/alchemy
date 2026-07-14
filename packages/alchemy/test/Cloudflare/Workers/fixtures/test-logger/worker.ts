import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Fixture worker for `TestLogger.test.ts`.
 *
 * `GET /log?msg=...` writes the message via `console.log`. When the stack is
 * deployed with test logging enabled, the bundle's virtual entry patches
 * `console.*` so the message is mirrored to the account's test-logger
 * Durable Object — which the test then tails over a websocket.
 */
export default class LogTestWorker extends Cloudflare.Worker<LogTestWorker>()(
  "LogTestWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");

        if (request.method === "GET" && url.pathname === "/log") {
          const msg = url.searchParams.get("msg") ?? "(no message)";
          yield* Effect.sync(() => console.log(msg));
          return yield* HttpServerResponse.json({ logged: msg });
        }

        return HttpServerResponse.text("ok");
      }),
    };
  }),
) {}
