import * as lang from "@distilled.cloud/azure/cognitiveservices-language-analyze-text";
import * as Layer from "effect/Layer";
import { LanguageRole, makeAccountDataHttpBinding } from "./AccountDataBindingHttp.ts";
import { GetAnalyzeTextJob } from "./GetAnalyzeTextJob.ts";

/**
 * Implementation of {@link GetAnalyzeTextJob} over the distilled `cognitiveservices-language-analyze-text`
 * data plane. Assigns the custom `AzureCognitiveServicesLanguageReadAnalyzeTextJobRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetAnalyzeTextJob
 */
export const GetAnalyzeTextJobHttp = Layer.effect(
  GetAnalyzeTextJob,
  makeAccountDataHttpBinding({
    tag: "Azure.CognitiveServices.GetAnalyzeTextJob",
    operation: lang.AnalyzeTextJobStatus,
    grant: LanguageRole.ReadAnalyzeTextJob,
  }),
);
