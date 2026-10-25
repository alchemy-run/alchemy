import * as health from "@distilled.cloud/azure/ai-health-insights";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { GetRadiologyInsightsJob } from "./GetRadiologyInsightsJob.ts";

/**
 * Implementation of {@link GetRadiologyInsightsJob} over the distilled `ai-health-insights`
 * data plane. Assigns the custom `AzureAIRadiologyInsightsJobsReadRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetRadiologyInsightsJob
 */
export const GetRadiologyInsightsJobHttp = Layer.effect(
  GetRadiologyInsightsJob,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.GetRadiologyInsightsJob",
    operation: health.GetRadiologyInsightJob,
    grant: AIRole.RadiologyInsightsJobsRead,
  }),
);
