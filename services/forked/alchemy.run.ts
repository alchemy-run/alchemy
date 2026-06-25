import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import SandboxLive from "./src/agent/Sandbox.ts";
import Feed from "./src/Worker.ts";

/**
 * "forked" — Twitter for code repositories, built on Cloudflare Workers,
 * Durable Objects, Artifacts, and Containers.
 *
 * The API is a single Effect-native Worker (`Feed`, see `src/Worker.ts`) that
 * hosts the `Post` and `CoderSession` Durable Objects and binds the `Repos`
 * Artifacts namespace. Each post spins up a `CoderSession` that drives the
 * `Coder` agent inside the `Sandbox` container, so `SandboxLive` is provided
 * here at the stack root.
 */
export default Alchemy.Stack(
  "Forked",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const feed = yield* Feed;
    return { url: feed.url.as<string>() };
  }).pipe(Effect.provide(SandboxLive)),
);
