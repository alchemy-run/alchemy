import * as Effect from "effect/Effect";
import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import HarnessBoxLive from "./box.runtime.ts";
import HarnessWorker from "./worker.ts";

export const state = Alchemy.inMemoryState();

export default Alchemy.Stack(
  "HarnessStack",
  { providers: Cloudflare.providers(), state },
  Effect.gen(function* () {
    const worker = yield* HarnessWorker;
    return { url: worker.url.as<string>() };
  }).pipe(Effect.provide(HarnessBoxLive)),
);
