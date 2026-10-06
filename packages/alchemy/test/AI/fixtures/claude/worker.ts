import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Cloudflare from "@/Cloudflare";
import { Agent } from "./agent.ts";

/** `POST /run?id=<session>` with a prompt body: start the session, run one turn, return the result. */
export default Cloudflare.Worker(
  "AgentWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const agents = yield* Agent;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        if (url.pathname !== "/run") return HttpServerResponse.text("ok");
        const id = url.searchParams.get("id") ?? "default";
        const prompt = yield* request.text;
        // Each step reports itself if it stalls, so a hang names its hop.
        const step = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>) =>
          effect.pipe(
            Effect.timeoutOrElse({
              duration: "120 seconds",
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
