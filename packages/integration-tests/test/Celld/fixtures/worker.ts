/** Celld conformance routes and worker-level RPC for the Lambda caller. */
import * as Effect from "effect/Effect";
import { conformanceFetch } from "../../Cloudflare/Workers/conformance/routes.ts";
import { Counter, CounterLive } from "./counter.ts";
import { ConformanceWorker } from "./fleet.ts";

/** The worker-level RPC surface (the impl shape minus `fetch`). */
export interface ConformanceWorkerRpc {
  whoami: () => Effect.Effect<string>;
}

export default ConformanceWorker.make(
  { main: import.meta.url },
  Effect.gen(function* () {
    const counters = yield* Counter;
    return {
      fetch: conformanceFetch(counters),
      whoami: () => Effect.succeed("fleet-worker"),
    };
  }).pipe(Effect.provide(CounterLive)),
);
