import * as Boat from "@alchemy.run/boat";
import * as Effect from "effect/Effect";
import { CollectorTelemetry, tracedFetch } from "../../Utils/Telemetry.ts";

/** An Effect program that exports one span per `/work` request over OTLP. */
export default class TracedAgent extends Boat.Sandbox<TracedAgent>()(
  "TracedAgent",
  { main: import.meta.url, type: "small", noEnv: true },
  Effect.succeed({ fetch: tracedFetch }).pipe(
    Effect.provide(CollectorTelemetry("boat-sandbox-e2e")),
  ),
) {}
