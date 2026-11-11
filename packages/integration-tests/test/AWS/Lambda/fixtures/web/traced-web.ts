import * as Lambda from "@alchemy.run/aws/Lambda";
import * as Effect from "effect/Effect";
import { CollectorTelemetry, tracedFetch } from "../../../../Utils/Telemetry.ts";

export class TracedWebFunction extends Lambda.WebFunction<Lambda.WebFunction>()(
  "TracedWebFunction",
) {}

/** A web function that exports one span per `/work` request over OTLP. */
export default TracedWebFunction.make(
  { main: import.meta.url, authType: "ApplicationManaged" },
  Effect.succeed({ fetch: tracedFetch }).pipe(Effect.provide(CollectorTelemetry("lambda-web-e2e"))),
);
