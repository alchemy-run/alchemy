import * as Effect from "effect/Effect";
import { Actors } from "./cluster.ts";
import { Counter, CounterLive } from "./counter.ts";
import { ActorWorker } from "./worker.ts";

/**
 * The deploy module: the native `ActorWorker.make(props, impl)` form —
 * the cluster is named on the props, the Durable Object is the same
 * `Cloudflare.DurableObject` a Cloudflare deployment would host.
 */
export default ActorWorker.make(
  { cluster: Actors, main: import.meta.url },
  Effect.gen(function* () {
    // Registers the Durable Object on the worker (the runner serves it as
    // a Rivet actor at runtime).
    yield* Counter;
    return {};
  }).pipe(Effect.provide(CounterLive)),
);
