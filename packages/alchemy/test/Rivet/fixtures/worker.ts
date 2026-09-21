/** Rivet actors reached through the gateway by the fronting Lambda. */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ConformanceActors, ConformanceWorker } from "./cluster.ts";
import { Counter, CounterLive } from "./counter.ts";
import { InitProbe, InitProbeLive } from "./probe.ts";

export default ConformanceWorker.make(
  { cluster: ConformanceActors, main: import.meta.url },
  Effect.gen(function* () {
    // Registers the Durable Objects on the worker; the runner serves them
    // as Rivet actors.
    yield* Counter;
    yield* InitProbe;
    return {};
  }).pipe(Effect.provide(Layer.mergeAll(CounterLive, InitProbeLive))),
);
