/**
 * The Effectful Constructor, locally — the Server.Service analog of a
 * Cloudflare Worker fixture. Imported by the TEST (to declare/deploy)
 * AND by alchemy's Server entry inside the detached process (to run) —
 * the same module, two phases, like `main: import.meta.url` everywhere
 * else. Uses package self-references ("alchemy/…") since nothing is
 * bundled and the runtime imports this file directly.
 *
 * No port anywhere: the runtime binds an ephemeral one and the
 * reconciler learns it through the startup handshake — the test reads
 * it from the stack's `url` output.
 */
import * as Server from "alchemy/Server";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export default class TestApi extends Server.Service<TestApi>()(
  "TestApi",
  { main: import.meta.url, memo: false },
  Effect.gen(function* () {
    // instance scope: plain state shared by every request
    let hits = 0;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        hits++;
        return yield* HttpServerResponse.json({
          ok: true,
          hits,
          url: request.url,
          stack: process.env.ALCHEMY_STACK_NAME,
        });
      }).pipe(Effect.orDie),
    };
  }),
) {}
