import * as contentSafety from "@distilled.cloud/azure/cognitiveservices-content-safety";
import * as Layer from "effect/Layer";
import { ContentSafetyRole, makeAccountDataHttpBinding } from "./AccountDataBindingHttp.ts";
import { AnalyzeTextSafety } from "./AnalyzeTextSafety.ts";

/**
 * Implementation of {@link AnalyzeTextSafety} over the distilled `cognitiveservices-content-safety`
 * data plane. Assigns the custom `AzureCognitiveServicesContentSafetyAnalyzeTextRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.AnalyzeTextSafety
 */
export const AnalyzeTextSafetyHttp = Layer.effect(
  AnalyzeTextSafety,
  makeAccountDataHttpBinding({
    tag: "Azure.CognitiveServices.AnalyzeTextSafety",
    operation: contentSafety.TextOperationsAnalyzeText,
    grant: ContentSafetyRole.AnalyzeText,
  }),
);
