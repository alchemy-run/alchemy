/**
 * The conformance worker, deployed to a **celld fleet**. As with the
 * Cloudflare instantiation, the only platform-specific line is the target
 * layer — the Durable Object and the HTTP surface are the shared ones.
 */
import * as Celld from "@/Celld";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Counter, counterLive } from "../counter.ts";
import { conformanceFetch } from "../routes.ts";
import { ConformanceCells, ConformanceWorker } from "./fleet.ts";

export const CounterLive = counterLive(ConformanceWorker);

export default ConformanceWorker.make(
  Effect.gen(function* () {
    const counters = yield* Counter;
    return { fetch: conformanceFetch(counters) };
  }).pipe(
    Effect.provide(
      CounterLive.pipe(
        Layer.provideMerge(
          Celld.Worker({ fleet: ConformanceCells, main: import.meta.url }),
        ),
      ),
    ),
  ),
);
