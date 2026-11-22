import type * as streamanalytics from "@distilled.cloud/azure/streamanalytics";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { StreamingJob } from "./StreamingJob.ts";

export interface ScaleStreamingJobRequest extends Omit<
  streamanalytics.ScaleStreamingJobRequest,
  "subscriptionId" | "resourceGroupName" | "jobName"
> {}

/**
 * Change a running streaming job's streaming units (`POST …/streamingjobs/{jobName}/scale`) from any host.
 *
 * Binding assigns a custom role (`AzureStreamAnalyticsScaleStreamingJobRole`, one per stack, with
 * exactly the action `Microsoft.StreamAnalytics/streamingjobs/Scale/action`) on the streaming job only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link ScaleStreamingJobHttp}.
 *
 * ### Calling ScaleStreamingJob
 * **Example:** ScaleStreamingJob from a Function
 * ```typescript
 * // init
 * const scaleStreamingJob = yield* Azure.StreamAnalytics.ScaleStreamingJob(job);
 *
 * // runtime
 * yield* scaleStreamingJob({ streamingUnits: 3 });
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const scaleStreamingJob = yield* Azure.StreamAnalytics.ScaleStreamingJob(job);
 *   // ...
 * }).pipe(Effect.provide(Azure.StreamAnalytics.ScaleStreamingJobHttp));
 * ```
 *
 * @binding
 * @category StreamAnalytics
 */
export interface ScaleStreamingJob extends Binding.Service<
  ScaleStreamingJob,
  "Azure.StreamAnalytics.ScaleStreamingJob",
  (
    job: StreamingJob,
  ) => Effect.Effect<
    (
      request?: ScaleStreamingJobRequest,
    ) => Effect.Effect<
      streamanalytics.ScaleStreamingJobResponse,
      streamanalytics.ScaleStreamingJobError,
      RuntimeContext
    >
  >
> {}

export const ScaleStreamingJob = Binding.Service<ScaleStreamingJob>(
  "Azure.StreamAnalytics.ScaleStreamingJob",
);
