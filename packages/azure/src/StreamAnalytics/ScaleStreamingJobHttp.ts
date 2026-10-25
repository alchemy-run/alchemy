import * as streamanalytics from "@distilled.cloud/azure/streamanalytics";
import * as Layer from "effect/Layer";
import { StreamAnalyticsRole, makeStreamingJobActionBinding } from "./BindingHttp.ts";
import { ScaleStreamingJob } from "./ScaleStreamingJob.ts";

/**
 * Implementation of {@link ScaleStreamingJob} over the distilled `streamanalytics` ARM
 * API. Assigns the custom `AzureStreamAnalyticsScaleStreamingJobRole` on the streaming job.
 *
 * @layer
 * @provides Azure.StreamAnalytics.ScaleStreamingJob
 */
export const ScaleStreamingJobHttp = Layer.effect(
  ScaleStreamingJob,
  makeStreamingJobActionBinding({
    tag: "Azure.StreamAnalytics.ScaleStreamingJob",
    operation: streamanalytics.ScaleStreamingJob,
    role: StreamAnalyticsRole.ScaleStreamingJob,
  }),
);
