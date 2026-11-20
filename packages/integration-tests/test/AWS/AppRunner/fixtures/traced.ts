import * as AWS from "@alchemy.run/aws";
import * as Effect from "effect/Effect";
import { CollectorTelemetry, tracedFetch } from "../../../Utils/Telemetry.ts";

/** An App Runner service program that exports one span per `/work` request over OTLP. */
export default class TracedService extends AWS.AppRunner.Service<TracedService>()(
  "AppRunnerTracedService",
  {
    main: import.meta.filename,
    port: 3000,
    instanceConfiguration: { cpu: "256", memory: "512" },
    // See service.ts: Docker Hub's bun image avoids public.ecr.aws pull limits.
    docker: { base: "oven/bun:1" },
  },
  Effect.succeed({ fetch: tracedFetch }).pipe(
    Effect.provide(CollectorTelemetry("apprunner-service-e2e")),
  ),
) {}
