import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import SandboxLive from "./sandbox.runtime.ts";
import Worker from "./worker.ts";

export default (state = Cloudflare.state()) =>
  Alchemy.Stack(
    "AiHarnessStack",
    { providers: Cloudflare.providers(), state },
    Effect.gen(function* () {
      const worker = yield* Worker;
      return { url: worker.url.as<string>() };
    }).pipe(Effect.provide(SandboxLive)),
  );
