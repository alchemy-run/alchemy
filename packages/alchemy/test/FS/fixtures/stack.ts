import * as Effect from "effect/Effect";
import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import MountBoxLive from "./container.runtime.ts";
import MountWorker from "./worker.ts";

export const providers = Cloudflare.providers();
export const state = Alchemy.inMemoryState();

export default Alchemy.Stack(
  "FSMountStack",
  { providers, state },
  Effect.gen(function* () {
    const worker = yield* MountWorker;
    return { url: worker.url.as<string>() };
  }).pipe(Effect.provide(MountBoxLive)),
);
