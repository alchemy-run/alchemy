import * as Daytona from "@alchemy.run/daytona";
import * as Effect from "effect/Effect";
import { CollectorTelemetry, tracedFetch } from "../../../Utils/Telemetry.ts";
import { PROGRAM_PORT } from "./shared.ts";

/** An Effect program that exports one span per `/work` request over OTLP. */
export default class TracedAgent extends Daytona.Sandbox<TracedAgent>()(
  "TracedAgent",
  { main: import.meta.url, port: PROGRAM_PORT, public: true },
  Effect.succeed({ fetch: tracedFetch }).pipe(
    Effect.provide(CollectorTelemetry("daytona-sandbox-e2e")),
  ),
) {}
