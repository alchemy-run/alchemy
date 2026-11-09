import * as Railway from "@alchemy.run/railway";
import * as Effect from "effect/Effect";
import { CollectorTelemetry, tracedFetch } from "../../Utils/Telemetry.ts";
import { Partition, Site } from "./suite-env.ts";

/** An HTTP Service that exports one span per `/work` request over OTLP. */
export default class TracedApi extends Railway.Service<TracedApi>()(
  "TracedApi",
  { project: Site, environment: Partition, main: import.meta.url, port: 3000 },
  Effect.succeed({ fetch: tracedFetch }).pipe(
    Effect.provide(CollectorTelemetry("railway-service-e2e")),
  ),
) {}
