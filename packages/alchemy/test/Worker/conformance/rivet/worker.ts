/**
 * The conformance worker, deployed to a **Rivet cluster**. The definition
 * is the same cloud-free `make`; only the deploy module names Rivet.
 *
 * Rivet inverts the other engines: this module becomes a RUNNER container
 * (an ECS service with no inbound ports) whose actors are reached through
 * the engine's gateway — so the worker itself serves no HTTP; the shared
 * routes are re-exposed by the fronting Lambda ([api.ts](./api.ts)).
 */
import * as Rivet from "@/Rivet";
import * as Effect from "effect/Effect";
import { Counter, CounterLive } from "../counter.ts";
import { ConformanceActors, ConformanceWorker } from "./cluster.ts";

export default Rivet.Worker(
  ConformanceWorker,
  { cluster: ConformanceActors, main: import.meta.url },
  ConformanceWorker.make(
    Effect.gen(function* () {
      // Registers the Durable Object on the worker; the runner serves it
      // as a Rivet actor.
      yield* Counter;
      return {};
    }).pipe(Effect.provide(CounterLive)),
  ),
);
