import * as Cloudflare from "@/Cloudflare";
import SandboxContainerRuntime from "@/Cloudflare/AI/SandboxContainerRuntime.ts";
import * as Alchemy from "@/index.ts";
import * as Effect from "effect/Effect";
import SandboxWorker from "./worker.ts";

export default Alchemy.Stack(
  "SandboxContainerStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* SandboxWorker;
    return { url: worker.url.as<string>() };
  }).pipe(
    // the `.make()` default export registers the container's runtime;
    // providing it is what builds the image and deploys the application
    Effect.provide(SandboxContainerRuntime),
  ),
);
