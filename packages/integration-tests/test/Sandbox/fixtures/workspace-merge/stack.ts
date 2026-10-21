import * as Cloudflare from "@alchemy.run/cloudflare";
import { DockerLive } from "@alchemy.run/docker/Docker";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import MergeWorker from "./worker.ts";
import MergeWorkspaceLive from "./workspace.cloudflare.ts";

// The machine's image builds from a Dockerfile, with Docker.
export const providers = Layer.mergeAll(Cloudflare.providers(), DockerLive);
export const state = Alchemy.inMemoryState();

export default Alchemy.Stack(
  "MergeWorkspaceStack",
  { providers, state },
  Effect.gen(function* () {
    const worker = yield* MergeWorker;
    return { url: worker.url.as<string>() };
  }).pipe(Effect.provide(MergeWorkspaceLive)),
);
