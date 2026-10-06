import * as Effect from "effect/Effect";
import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import SandboxLive from "./sandbox.runtime.ts";
import Worker from "./worker.ts";

export default (state = Cloudflare.state()) =>
  Alchemy.Stack(
    "AiClaudeContainerStack",
    { providers: Cloudflare.providers(), state },
    Effect.gen(function* () {
      const worker = yield* Worker;
      return { url: worker.url.as<string>() };
    }).pipe(Effect.provide(SandboxLive)),
  );
