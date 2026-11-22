import type * as streamanalytics from "@distilled.cloud/azure/streamanalytics";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { StreamingJob } from "./StreamingJob.ts";

export interface StopStreamingJobRequest extends Omit<
  streamanalytics.StopStreamingJobRequest,
  "subscriptionId" | "resourceGroupName" | "jobName"
> {}

/**
 * Stop a running streaming job (`POST …/streamingjobs/{jobName}/stop`) from any host.
 *
 * Binding assigns a custom role (`AzureStreamAnalyticsStopStreamingJobRole`, one per stack, with
 * exactly the action `Microsoft.StreamAnalytics/streamingjobs/Stop/action`) on the streaming job only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link StopStreamingJobHttp}.
 *
 * ### Calling StopStreamingJob
 * **Example:** StopStreamingJob from a Function
 * ```typescript
 * // init
 * const stopStreamingJob = yield* Azure.StreamAnalytics.StopStreamingJob(job);
 *
 * // runtime
 * yield* stopStreamingJob();
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const stopStreamingJob = yield* Azure.StreamAnalytics.StopStreamingJob(job);
 *   // ...
 * }).pipe(Effect.provide(Azure.StreamAnalytics.StopStreamingJobHttp));
 * ```
 *
 * @binding
 * @category StreamAnalytics
 */
export interface StopStreamingJob extends Binding.Service<
  StopStreamingJob,
  "Azure.StreamAnalytics.StopStreamingJob",
  (
    job: StreamingJob,
  ) => Effect.Effect<
    (
      request?: StopStreamingJobRequest,
    ) => Effect.Effect<
      streamanalytics.StopStreamingJobResponse,
      streamanalytics.StopStreamingJobError,
      RuntimeContext
    >
  >
> {}

export const StopStreamingJob = Binding.Service<StopStreamingJob>(
  "Azure.StreamAnalytics.StopStreamingJob",
);
