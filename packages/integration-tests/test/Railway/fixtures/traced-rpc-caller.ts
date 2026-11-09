import * as Railway from "@alchemy.run/railway";
import { bindService } from "@alchemy.run/railway/Bind";
import * as Effect from "effect/Effect";
import { CollectorTelemetry, tracedCallerFetch } from "../../Utils/Telemetry.ts";
import { Partition, Site } from "./suite-env.ts";
import TracedCallee from "./traced-rpc-callee.ts";

/** A Service that calls {@link TracedCallee} over the private mesh inside a span of its own. */
export default class TracedCaller extends Railway.Service<TracedCaller>()(
  "TracedCaller",
  { project: Site, environment: Partition, main: import.meta.url, port: 3000 },
  Effect.gen(function* () {
    const callee = yield* bindService(TracedCallee);
    return { fetch: tracedCallerFetch(callee) };
  }).pipe(Effect.provide(CollectorTelemetry("railway-rpc-caller"))),
) {}
