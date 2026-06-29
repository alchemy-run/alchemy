import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import * as Effect from "effect/Effect";
import BenchEffectfulContainerLive from "./effectful-container.ts";
import BenchWorker from "./worker.ts";

export default Alchemy.Stack(
  "ContainerBenchmarkStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* BenchWorker;
    return {
      url: worker.url.as<string>(),
    };
    // The effectful container's `.make()` runtime must be reachable so the
    // bundler emits its entrypoint; the remote container is image-only and
    // needs no runtime layer.
  }).pipe(Effect.provide(BenchEffectfulContainerLive)),
);
