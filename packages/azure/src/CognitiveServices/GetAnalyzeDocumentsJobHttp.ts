import * as documents from "@distilled.cloud/azure/cognitiveservices-language-analyze-documents";
import * as Layer from "effect/Layer";
import { LanguageRole, makeAccountDataHttpBinding } from "./AccountDataBindingHttp.ts";
import { GetAnalyzeDocumentsJob } from "./GetAnalyzeDocumentsJob.ts";

/**
 * Implementation of {@link GetAnalyzeDocumentsJob} over the distilled `cognitiveservices-language-analyze-documents`
 * data plane. Assigns the custom `AzureCognitiveServicesLanguageReadAnalyzeDocumentsJobRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetAnalyzeDocumentsJob
 */
export const GetAnalyzeDocumentsJobHttp = Layer.effect(
  GetAnalyzeDocumentsJob,
  makeAccountDataHttpBinding({
    tag: "Azure.CognitiveServices.GetAnalyzeDocumentsJob",
    operation: documents.AnalyzeDocumentsJobStatus,
    grant: LanguageRole.ReadAnalyzeDocumentsJob,
  }),
);
