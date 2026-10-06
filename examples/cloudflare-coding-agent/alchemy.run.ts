import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import SandboxLive from "./src/Sandbox.runtime.ts";
import CodingAgents from "./src/worker.ts";

export default Alchemy.Stack(
  "CloudflareCodingAgent",
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* CodingAgents;
    return { url: worker.url.as<string>() };
  }).pipe(Effect.provide(SandboxLive)),
);
