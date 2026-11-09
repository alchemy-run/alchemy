import * as Hetzner from "@alchemy.run/hetzner";
import * as Effect from "effect/Effect";
import { CollectorTelemetry, tracedFetch } from "../../Utils/Telemetry.ts";
import { API_PORT, Box } from "./shared.ts";

/** An HTTP Service that exports one span per `/work` request over OTLP. */
export default class TracedApi extends Hetzner.Service<TracedApi>()(
  "TracedApi",
  { server: Box, main: import.meta.url, port: API_PORT },
  Effect.succeed({ fetch: tracedFetch }).pipe(
    Effect.provide(CollectorTelemetry("hetzner-service-e2e")),
  ),
) {}
