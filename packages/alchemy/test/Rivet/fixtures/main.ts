import * as Rivet from "@/Rivet";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Actors } from "./cluster.ts";
import { Counter, CounterLive } from "./counter.ts";
import { ActorWorker } from "./worker.ts";

/**
 * The deployable Worker module. The impl carries its capability layers AND
 * its deployment target in one provide chain — `Rivet.Worker({ cluster })`
 * is what makes this a Rivet deployment; a different target layer would
 * deploy the same worker elsewhere.
 */
export default ActorWorker.make(
  Effect.gen(function* () {
    // Registers the Durable Object on the worker (and resolves the
    // namespace handle over the gateway-backed environment at runtime).
    yield* Counter;
    return {};
  }).pipe(
    Effect.provide(
      CounterLive.pipe(
        Layer.provideMerge(
          Rivet.Worker({ cluster: Actors, main: import.meta.url }),
        ),
      ),
    ),
  ),
);
