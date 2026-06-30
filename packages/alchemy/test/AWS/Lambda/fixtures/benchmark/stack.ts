import * as AWS from "@/AWS";
import * as Alchemy from "@/index.ts";
import * as Effect from "effect/Effect";
import BenchOrchestrator from "./orchestrator.ts";
import SandboxLive from "../microvm/sandbox.ts";

/**
 * MicroVM cold-start benchmark stack: deploys the {@link SandboxLive} image and
 * the {@link BenchOrchestrator} Lambda that boots fresh MicroVMs on demand.
 * Exposes the orchestrator's function URL so the benchmark can fire N concurrent
 * `/boot` requests.
 */
export default Alchemy.Stack(
  "MicrovmBenchmarkStack",
  {
    providers: AWS.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const fn = yield* BenchOrchestrator;
    return { url: fn.functionUrl.as<string>() };
  }).pipe(Effect.provide(SandboxLive)),
);
