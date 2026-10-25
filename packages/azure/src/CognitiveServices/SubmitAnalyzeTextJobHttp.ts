import * as lang from "@distilled.cloud/azure/cognitiveservices-language-analyze-text";
import * as Layer from "effect/Layer";
import { LanguageRole, makeAccountDataHttpBinding } from "./AccountDataBindingHttp.ts";
import { SubmitAnalyzeTextJob } from "./SubmitAnalyzeTextJob.ts";

/**
 * Implementation of {@link SubmitAnalyzeTextJob} over the distilled `cognitiveservices-language-analyze-text`
 * data plane. Assigns the custom `AzureCognitiveServicesLanguageSubmitAnalyzeTextJobRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.SubmitAnalyzeTextJob
 */
export const SubmitAnalyzeTextJobHttp = Layer.effect(
  SubmitAnalyzeTextJob,
  makeAccountDataHttpBinding({
    tag: "Azure.CognitiveServices.SubmitAnalyzeTextJob",
    operation: lang.AnalyzeTextSubmitJob,
    grant: LanguageRole.SubmitAnalyzeTextJob,
  }),
);
