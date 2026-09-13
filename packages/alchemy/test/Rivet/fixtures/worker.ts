/**
 * The conformance worker's deploy module — the native `Rivet.Worker`
 * tag + `.make(props, impl)` form. The Durable Object is the SAME
 * `Cloudflare.DurableObject` fixture every engine hosts.
 *
 * Rivet inverts the other engines: this module becomes a RUNNER container
 * (an ECS service with no inbound ports) whose actors are reached through
 * the engine's gateway — so the worker itself serves no HTTP; the shared
 * routes are re-exposed by the fronting Lambda ([api.ts](./api.ts)).
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  Counter,
  CounterLive,
} from "../../Cloudflare/Workers/conformance/counter.ts";
import { ConformanceActors, ConformanceWorker } from "./cluster.ts";
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
