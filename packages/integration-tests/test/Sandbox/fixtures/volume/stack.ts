import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import VolumeSandboxLive from "./box.runtime.ts";
import VolumeWorker from "./worker.ts";
import TestWorkspaceLive from "./workspace.runtime.ts";

export const providers = Cloudflare.providers();
export const state = Alchemy.inMemoryState();

export default Alchemy.Stack(
  "VolumeStack",
  { providers, state },
  Effect.gen(function* () {
    const worker = yield* VolumeWorker;
    return { url: worker.url.as<string>() };
  }).pipe(Effect.provide(Layer.mergeAll(VolumeSandboxLive, TestWorkspaceLive))),
);
