/**
 * The conformance worker, deployed to **Cloudflare**. The definition
 * (`ConformanceWorker.make`) is cloud-free; the default export is the
 * deploy module — the only Cloudflare-specific lines in the suite.
 */
import * as Alchemy from "@/index.ts";
import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import { Counter, CounterLive } from "../counter.ts";
import { conformanceFetch } from "../routes.ts";

export class ConformanceWorker extends Alchemy.Worker<ConformanceWorker>()(
  "CfConformance",
) {}

export default Cloudflare.Worker(
  ConformanceWorker,
  {
    main: import.meta.url,
    workersDev: true,
    compatibility: { date: "2025-06-01" },
  },
  ConformanceWorker.make(
    Effect.gen(function* () {
      const counters = yield* Counter;
      return { fetch: conformanceFetch(counters) };
    }).pipe(Effect.provide(CounterLive)),
  ),
);
