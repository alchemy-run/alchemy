import * as documents from "@distilled.cloud/azure/cognitiveservices-language-analyze-documents";
import * as Layer from "effect/Layer";
import { LanguageRole, makeAccountDataHttpBinding } from "./AccountDataBindingHttp.ts";
import { SubmitAnalyzeDocumentsJob } from "./SubmitAnalyzeDocumentsJob.ts";

/**
 * Implementation of {@link SubmitAnalyzeDocumentsJob} over the distilled `cognitiveservices-language-analyze-documents`
 * data plane. Assigns the custom `AzureCognitiveServicesLanguageSubmitAnalyzeDocumentsJobRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.SubmitAnalyzeDocumentsJob
 */
export const SubmitAnalyzeDocumentsJobHttp = Layer.effect(
  SubmitAnalyzeDocumentsJob,
  makeAccountDataHttpBinding({
    tag: "Azure.CognitiveServices.SubmitAnalyzeDocumentsJob",
    operation: documents.AnalyzeDocumentsSubmitJob,
    grant: LanguageRole.SubmitAnalyzeDocumentsJob,
  }),
);
