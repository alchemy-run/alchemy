import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Cloudflare from "@/Cloudflare";
import { Agent } from "./agent.ts";

/** `POST /run/<harness>?id=<session>` with a prompt body: start, run one turn, return the result. */
export default Cloudflare.Worker(
  "HarnessWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const agents = yield* Agent;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        const match = /^\/run\/(claude|codex|opencode)$/.exec(url.pathname);
        if (!match) return HttpServerResponse.text("ok");
        const id = `${match[1]}:${url.searchParams.get("id") ?? "default"}`;
        const prompt = yield* request.text;
        // Each step reports itself if it stalls, so a hang names its hop.
        const step = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>) =>
          effect.pipe(
            Effect.timeoutOrElse({
              duration: "150 seconds",
              orElse: () => Effect.die(new Error(`step "${name}" timed out`)),
            }),
          );
        const agent = yield* step("getByName", agents.getByName(id));
        const info = yield* step("start", agent.start({}));
        const turn = yield* step("prompt", agent.prompt({ prompt }));
        const result = yield* step("result", agent.result({ turnId: turn.turnId }));
        return yield* HttpServerResponse.json({ info, result });
      }).pipe(
        Effect.scoped,
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(`error: ${String(cause)}`, { status: 500 })),
        ),
      ),
    };
  }),
);
