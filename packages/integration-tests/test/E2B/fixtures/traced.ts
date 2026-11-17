import * as E2B from "@alchemy.run/e2b";
import * as Effect from "effect/Effect";
import { CollectorTelemetry, tracedFetch } from "../../Utils/Telemetry.ts";

/** A template program that exports one span per `/work` request over OTLP. */
export default class TracedTemplate extends E2B.Template<TracedTemplate>()(
  "TracedTemplate",
  { main: import.meta.url, port: 3000 },
  Effect.succeed({ fetch: tracedFetch }).pipe(
    Effect.provide(CollectorTelemetry("e2b-template-e2e")),
  ),
) {}
