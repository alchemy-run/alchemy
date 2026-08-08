/**
 * The conformance worker, deployed to a **celld fleet**. The definition
 * is the same cloud-free `make`; only the deploy module names celld.
 */
import * as Celld from "@/Celld";
import * as Effect from "effect/Effect";
import { Counter, CounterLive } from "../counter.ts";
import { conformanceFetch } from "../routes.ts";
import { ConformanceCells, ConformanceWorker } from "./fleet.ts";

export default Celld.Worker(
  ConformanceWorker,
  { fleet: ConformanceCells, main: import.meta.url },
  ConformanceWorker.make(
    Effect.gen(function* () {
      const counters = yield* Counter;
      return { fetch: conformanceFetch(counters) };
    }).pipe(Effect.provide(CounterLive)),
  ),
);
