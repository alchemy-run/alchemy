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
        const harness = match[1]!;
        const session = url.searchParams.get("id") ?? "default";
        const prompt = yield* request.text;
        // Each step reports itself if it stalls, so a hang names its hop.
        const step = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>) =>
          effect.pipe(
            Effect.timeoutOrElse({
              duration: "150 seconds",
              orElse: () => Effect.die(new Error(`step "${name}" timed out`)),
            }),
          );
        // One Durable Object (and container) per session.
        const agent = agents.getByName(`${harness}:${session}`);
        const { info, result } = yield* step("run", agent.run(harness, session, prompt));
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
