/**
 * The conformance worker, deployed to a **Rivet cluster**. As with the
 * other instantiations, the only platform-specific line is the target
 * layer — the Durable Object is the shared one.
 *
 * Rivet inverts the other engines: this module becomes a RUNNER container
 * (an ECS service with no inbound ports) whose actors are reached through
 * the engine's gateway — so the worker itself serves no HTTP; the shared
 * routes are re-exposed by the fronting Lambda ([api.ts](./api.ts)).
 */
import * as Rivet from "@/Rivet";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Counter, counterLive } from "../counter.ts";
import { ConformanceActors, ConformanceWorker } from "./cluster.ts";

export const CounterLive = counterLive(ConformanceWorker);

export default ConformanceWorker.make(
  Effect.gen(function* () {
    // Registers the Durable Object on the worker; the runner serves it as
    // a Rivet actor.
    yield* Counter;
    return {};
  }).pipe(
    Effect.provide(
      CounterLive.pipe(
        Layer.provideMerge(
          Rivet.Worker({ cluster: ConformanceActors, main: import.meta.url }),
        ),
      ),
    ),
  ),
);
