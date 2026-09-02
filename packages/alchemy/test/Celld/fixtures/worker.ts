/**
 * The conformance worker's deploy module — the native `Celld.Worker`
 * tag + `.make(props, impl)` form. The Durable Object is the SAME
 * `Cloudflare.DurableObject` fixture every engine hosts. Alongside the
 * shared `fetch` surface it exposes one worker-level RPC method, which the
 * Lambda caller reaches through `Celld.bindWorker`'s schemaless stub.
 */
import * as Effect from "effect/Effect";
import {
  Counter,
  CounterLive,
} from "../../Cloudflare/Workers/conformance/counter.ts";
import { conformanceFetch } from "../../Cloudflare/Workers/conformance/routes.ts";
import { ConformanceCells, ConformanceWorker } from "./fleet.ts";

/** The worker-level RPC surface (the impl shape minus `fetch`). */
export interface ConformanceWorkerRpc {
  whoami: () => Effect.Effect<string>;
}

export default ConformanceWorker.make(
  { fleet: ConformanceCells, main: import.meta.url },
  Effect.gen(function* () {
    const counters = yield* Counter;
    return {
      fetch: conformanceFetch(counters),
      whoami: () => Effect.succeed("fleet-worker"),
    };
  }).pipe(Effect.provide(CounterLive)),
);
