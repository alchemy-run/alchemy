import * as streamanalytics from "@distilled.cloud/azure/streamanalytics";
import * as Layer from "effect/Layer";
import { StreamAnalyticsRole, makeStreamingJobActionBinding } from "./BindingHttp.ts";
import { StopStreamingJob } from "./StopStreamingJob.ts";

/**
 * Implementation of {@link StopStreamingJob} over the distilled `streamanalytics` ARM
 * API. Assigns the custom `AzureStreamAnalyticsStopStreamingJobRole` on the streaming job.
 *
 * @layer
 * @provides Azure.StreamAnalytics.StopStreamingJob
 */
export const StopStreamingJobHttp = Layer.effect(
  StopStreamingJob,
  makeStreamingJobActionBinding({
    tag: "Azure.StreamAnalytics.StopStreamingJob",
    operation: streamanalytics.StopStreamingJob,
    role: StreamAnalyticsRole.StopStreamingJob,
  }),
);
