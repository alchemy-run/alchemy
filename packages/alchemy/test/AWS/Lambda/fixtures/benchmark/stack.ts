import * as AWS from "@/AWS";
import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import BenchExternalLive from "./external-image.ts";
import BenchOrchestrator from "./orchestrator.ts";
import BenchWorker from "./worker.ts";
import SandboxLive from "../microvm/sandbox.ts";

/**
 * Cold-start benchmark stack. Deploys two MicroVM images — the effectful
 * {@link SandboxLive} (bundled Effect program) and the external
 * {@link BenchExternalLive} (plain Dockerfile) — plus two hosts that boot them:
 * a Lambda {@link BenchOrchestrator} and a Cloudflare {@link BenchWorker}. The
 * Worker host exercises the cross-cloud assume-role path. Exposes both hosts'
 * URLs so the benchmark can fire Lambda→MicroVM and Worker→MicroVM loads.
 */
export default Alchemy.Stack(
  "MicrovmBenchmarkStack",
  {
    providers: Layer.mergeAll(AWS.providers(), Cloudflare.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const fn = yield* BenchOrchestrator;
    const worker = yield* BenchWorker;
    return {
      url: fn.functionUrl.as<string>(),
      workerUrl: worker.url.as<string>(),
    };
  }).pipe(Effect.provide(Layer.mergeAll(SandboxLive, BenchExternalLive))),
);
