import * as lang from "@distilled.cloud/azure/cognitiveservices-language-analyze-text";
import * as Layer from "effect/Layer";
import { LanguageRole, makeAccountDataHttpBinding } from "./AccountDataBindingHttp.ts";
import { CancelAnalyzeTextJob } from "./CancelAnalyzeTextJob.ts";

/**
 * Implementation of {@link CancelAnalyzeTextJob} over the distilled `cognitiveservices-language-analyze-text`
 * data plane. Assigns the custom `AzureCognitiveServicesLanguageCancelAnalyzeTextJobRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.CancelAnalyzeTextJob
 */
export const CancelAnalyzeTextJobHttp = Layer.effect(
  CancelAnalyzeTextJob,
  makeAccountDataHttpBinding({
    tag: "Azure.CognitiveServices.CancelAnalyzeTextJob",
    operation: lang.AnalyzeTextCancelJob,
    grant: LanguageRole.CancelAnalyzeTextJob,
  }),
);
