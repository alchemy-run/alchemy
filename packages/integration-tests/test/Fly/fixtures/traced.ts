import * as Fly from "@alchemy.run/fly";
import * as Effect from "effect/Effect";
import { CollectorTelemetry, tracedFetch } from "../../Utils/Telemetry.ts";
import { API_PORT } from "./shared.ts";

export const TracedSite = Fly.App("TracedSite");

/** An HTTP Service that exports one span per `/work` request over OTLP. */
export default class TracedApi extends Fly.Service<TracedApi>()(
  "TracedApi",
  {
    app: TracedSite,
    main: import.meta.url,
    region: "iad",
    port: API_PORT,
    guest: { cpuKind: "shared", cpus: 1, memoryMb: 256 },
  },
  Effect.succeed({ fetch: tracedFetch }).pipe(
    Effect.provide(CollectorTelemetry("fly-service-e2e")),
  ),
) {}
