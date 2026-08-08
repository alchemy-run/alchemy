import * as Rivet from "@/Rivet";
import * as Effect from "effect/Effect";
import { Actors } from "./cluster.ts";
import { Counter, CounterLive } from "./counter.ts";
import { ActorWorker } from "./worker.ts";

/**
 * The deploy module: the definition (`ActorWorker.make`) is cloud-free;
 * `Rivet.Worker(ActorWorker, { cluster }, …)` is the only line that makes
 * this a Rivet deployment.
 */
export default Rivet.Worker(
  ActorWorker,
  { cluster: Actors, main: import.meta.url },
  ActorWorker.make(
    Effect.gen(function* () {
      // Registers the Durable Object on the worker (and resolves the
      // namespace handle over the gateway-backed environment at runtime).
      yield* Counter;
      return {};
    }).pipe(Effect.provide(CounterLive)),
  ),
);
