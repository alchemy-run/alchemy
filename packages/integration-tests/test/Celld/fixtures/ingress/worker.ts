/**
 * The ingress worker's deploy module: the SAME conformance fetch surface,
 * served through the fleet's public ingress on a custom domain on the
 * standing Cloudflare test zone (see `IngressCells` in ./fleet.ts).
 */
import * as Effect from "effect/Effect";
import { conformanceFetch } from "../../../Cloudflare/Workers/conformance/routes.ts";
import { Counter, CounterLive } from "./counter.ts";
import { IngressWorker } from "./fleet.ts";

export default IngressWorker.make(
  { main: import.meta.url },
  Effect.gen(function* () {
    const counters = yield* Counter;
    return { fetch: conformanceFetch(counters) };
  }).pipe(Effect.provide(CounterLive)),
);
