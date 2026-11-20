import * as AWS from "@alchemy.run/aws";
import * as Effect from "effect/Effect";
import { CollectorTelemetry } from "../../../Utils/Telemetry.ts";

/**
 * A run-to-completion job that makes one span, `work:batch`. The process
 * exits once `run` completes, so the span leaves on the exporters' final
 * flush when the bootstrap's scope closes.
 */
export default class TracedJob extends AWS.Batch.JobDefinition<TracedJob>()(
  "BatchTracedJob",
  {
    main: import.meta.filename,
    vcpus: 0.25,
    memory: 512,
    timeout: "10 minutes",
    // See nightly-job.ts: Docker Hub's bun image avoids public.ecr.aws pull limits.
    docker: { base: "oven/bun:1" },
  },
  Effect.succeed({
    run: Effect.log("traced job body").pipe(Effect.withSpan("work:batch")),
  }).pipe(Effect.provide(CollectorTelemetry("batch-job-e2e"))),
) {}
