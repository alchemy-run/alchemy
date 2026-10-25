import * as documents from "@distilled.cloud/azure/cognitiveservices-language-analyze-documents";
import * as Layer from "effect/Layer";
import { LanguageRole, makeAccountDataHttpBinding } from "./AccountDataBindingHttp.ts";
import { CancelAnalyzeDocumentsJob } from "./CancelAnalyzeDocumentsJob.ts";

/**
 * Implementation of {@link CancelAnalyzeDocumentsJob} over the distilled `cognitiveservices-language-analyze-documents`
 * data plane. Assigns the custom `AzureCognitiveServicesLanguageCancelAnalyzeDocumentsJobRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.CancelAnalyzeDocumentsJob
 */
export const CancelAnalyzeDocumentsJobHttp = Layer.effect(
  CancelAnalyzeDocumentsJob,
  makeAccountDataHttpBinding({
    tag: "Azure.CognitiveServices.CancelAnalyzeDocumentsJob",
    operation: documents.AnalyzeDocumentsCancelJob,
    grant: LanguageRole.CancelAnalyzeDocumentsJob,
  }),
);
