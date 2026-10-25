import * as health from "@distilled.cloud/azure/ai-health-insights";
import * as Layer from "effect/Layer";
import { AIRole, makeAccountHttpBinding } from "./AIBindingHttp.ts";
import { CreateRadiologyInsightsJob } from "./CreateRadiologyInsightsJob.ts";

/**
 * Implementation of {@link CreateRadiologyInsightsJob} over the distilled `ai-health-insights`
 * data plane. Assigns the custom `AzureAIRadiologyInsightsJobsWriteRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.CreateRadiologyInsightsJob
 */
export const CreateRadiologyInsightsJobHttp = Layer.effect(
  CreateRadiologyInsightsJob,
  makeAccountHttpBinding({
    tag: "Azure.CognitiveServices.CreateRadiologyInsightsJob",
    operation: health.CreateRadiologyInsightJob,
    grant: AIRole.RadiologyInsightsJobsWrite,
  }),
);
