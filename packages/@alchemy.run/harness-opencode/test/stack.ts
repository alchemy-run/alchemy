import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import OpenCodeContainer from "./fixtures/opencode-container.ts";
import Worker from "./fixtures/worker.ts";

/**
 * Integration-test stack: a Worker fronting an `Agent` Durable Object that
 * embeds the OpenCode {@link CodingAgentContainer}. `OpenCodeContainer` is
 * provided at the stack root (its `.make()` registers the container binding and
 * binds `ANTHROPIC_API_KEY`).
 */
export default Alchemy.Stack(
  "HarnessOpenCodeTest",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* Worker;
    return { url: worker.url.as<string>() };
  }).pipe(Effect.provide(OpenCodeContainer)),
);
