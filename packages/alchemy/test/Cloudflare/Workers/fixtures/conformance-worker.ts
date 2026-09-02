/**
 * The conformance worker, deployed to **Cloudflare** with the native
 * `Cloudflare.Worker` constructor.
 */
import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import { Counter, CounterLive } from "../conformance/counter.ts";
import { conformanceFetch } from "../conformance/routes.ts";

export default class ConformanceWorker extends Cloudflare.Worker<ConformanceWorker>()(
  "CfConformance",
  {
    main: import.meta.url,
    workersDev: true,
    compatibility: { date: "2025-06-01" },
  },
  Effect.gen(function* () {
    const counters = yield* Counter;
    return { fetch: conformanceFetch(counters) };
  }).pipe(Effect.provide(CounterLive)),
) {}
