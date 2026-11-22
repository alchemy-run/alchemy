import type * as streamanalytics from "@distilled.cloud/azure/streamanalytics";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { StreamingJob } from "./StreamingJob.ts";

export interface StartStreamingJobRequest extends Omit<
  streamanalytics.StartStreamingJobRequest,
  "subscriptionId" | "resourceGroupName" | "jobName"
> {}

/**
 * Start a streaming job (`POST …/streamingjobs/{jobName}/start`) from any host. Azure answers once the start is accepted; the job reaches `Running` a minute or two later. A running job bills its streaming units.
 *
 * Binding assigns a custom role (`AzureStreamAnalyticsStartStreamingJobRole`, one per stack, with
 * exactly the action `Microsoft.StreamAnalytics/streamingjobs/Start/action`) on the streaming job only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link StartStreamingJobHttp}.
 *
 * ### Calling StartStreamingJob
 * **Example:** StartStreamingJob from a Function
 * ```typescript
 * // init
 * const startStreamingJob = yield* Azure.StreamAnalytics.StartStreamingJob(job);
 *
 * // runtime
 * yield* startStreamingJob({ outputStartMode: "JobStartTime" });
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const startStreamingJob = yield* Azure.StreamAnalytics.StartStreamingJob(job);
 *   // ...
 * }).pipe(Effect.provide(Azure.StreamAnalytics.StartStreamingJobHttp));
 * ```
 *
 * @binding
 * @category StreamAnalytics
 */
export interface StartStreamingJob extends Binding.Service<
  StartStreamingJob,
  "Azure.StreamAnalytics.StartStreamingJob",
  (
    job: StreamingJob,
  ) => Effect.Effect<
    (
      request?: StartStreamingJobRequest,
    ) => Effect.Effect<
      streamanalytics.StartStreamingJobResponse,
      streamanalytics.StartStreamingJobError,
      RuntimeContext
    >
  >
> {}

export const StartStreamingJob = Binding.Service<StartStreamingJob>(
  "Azure.StreamAnalytics.StartStreamingJob",
);
