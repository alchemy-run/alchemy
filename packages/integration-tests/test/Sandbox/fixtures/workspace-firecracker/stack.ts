import * as AWS from "@alchemy.run/aws";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { DockerLive } from "@alchemy.run/docker/Docker";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import MicroVMWorkspaceWorker from "./worker.ts";
import MicroVMWorkspaceLive from "./workspace.aws.ts";

export const providers = Layer.mergeAll(AWS.providers(), Cloudflare.providers(), DockerLive);
export const state = Alchemy.inMemoryState();

export default Alchemy.Stack(
  "MicroVMWorkspaceStack",
  { providers, state },
  Effect.gen(function* () {
    const worker = yield* MicroVMWorkspaceWorker;
    return { url: worker.url.as<string>() };
  }).pipe(Effect.provide(MicroVMWorkspaceLive)),
);
