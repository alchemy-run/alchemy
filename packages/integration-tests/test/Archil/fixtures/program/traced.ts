import * as Archil from "@alchemy.run/archil";
import * as Effect from "effect/Effect";
import { CollectorTelemetry, tracedFetch } from "../../../Utils/Telemetry.ts";

/** An Effect program that exports one span per `/work` request over OTLP. */
export default class TracedApi extends Archil.Sandbox<TracedApi>()(
  "TracedApi",
  { main: import.meta.url, port: 3002, idleTtlSeconds: 300 },
  Effect.succeed({ fetch: tracedFetch }).pipe(
    Effect.provide(CollectorTelemetry("archil-sandbox-e2e")),
  ),
) {}
