import * as streamanalytics from "@distilled.cloud/azure/streamanalytics";
import * as Layer from "effect/Layer";
import { StreamAnalyticsRole, makeStreamingJobActionBinding } from "./BindingHttp.ts";
import { StartStreamingJob } from "./StartStreamingJob.ts";

/**
 * Implementation of {@link StartStreamingJob} over the distilled `streamanalytics` ARM
 * API. Assigns the custom `AzureStreamAnalyticsStartStreamingJobRole` on the streaming job.
 *
 * @layer
 * @provides Azure.StreamAnalytics.StartStreamingJob
 */
export const StartStreamingJobHttp = Layer.effect(
  StartStreamingJob,
  makeStreamingJobActionBinding({
    tag: "Azure.StreamAnalytics.StartStreamingJob",
    operation: streamanalytics.StartStreamingJob,
    role: StreamAnalyticsRole.StartStreamingJob,
  }),
);
