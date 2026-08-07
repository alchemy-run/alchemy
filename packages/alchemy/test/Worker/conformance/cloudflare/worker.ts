/**
 * The conformance worker, deployed to **Cloudflare**. The only
 * Cloudflare-specific line is the target layer.
 */
import * as Alchemy from "@/index.ts";
import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Counter, counterLive } from "../counter.ts";
import { conformanceFetch } from "../routes.ts";

export class ConformanceWorker extends Alchemy.Worker<ConformanceWorker>()(
  "CfConformance",
) {}

export const CounterLive = counterLive(ConformanceWorker);

export default ConformanceWorker.make(
  Effect.gen(function* () {
    const counters = yield* Counter;
    return { fetch: conformanceFetch(counters) };
  }).pipe(
    Effect.provide(
      CounterLive.pipe(
        Layer.provideMerge(
          Cloudflare.WorkerTarget({
            main: import.meta.url,
            workersDev: true,
            compatibility: { date: "2025-06-01" },
          }),
        ),
      ),
    ),
  ),
);
