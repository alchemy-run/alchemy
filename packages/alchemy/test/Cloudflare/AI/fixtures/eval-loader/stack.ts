import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import * as Effect from "effect/Effect";
import EvalLoaderEffectWorker from "./effect-worker.ts";
import EvalLoaderWorker from "./worker.ts";

export default Alchemy.Stack(
  "EvalWorkerLoaderStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* EvalLoaderWorker;
    const effectWorker = yield* EvalLoaderEffectWorker;
    return {
      url: worker.url.as<string>(),
      effectUrl: effectWorker.url.as<string>(),
    };
  }),
);
