/**
 * The conformance worker's deploy module — the native `Celld.Worker`
 * tag + `.make(props, impl)` form. The Durable Object is the SAME
 * `Cloudflare.DurableObject` fixture every engine hosts.
 */
import * as Effect from "effect/Effect";
import { Counter, CounterLive } from "../counter.ts";
import { conformanceFetch } from "../routes.ts";
import { ConformanceCells, ConformanceWorker } from "./fleet.ts";

export default ConformanceWorker.make(
  { fleet: ConformanceCells, main: import.meta.url },
  Effect.gen(function* () {
    const counters = yield* Counter;
    return { fetch: conformanceFetch(counters) };
  }).pipe(Effect.provide(CounterLive)),
);
