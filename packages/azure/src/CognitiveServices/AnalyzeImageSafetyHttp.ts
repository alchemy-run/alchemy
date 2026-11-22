import * as contentSafety from "@distilled.cloud/azure/cognitiveservices-content-safety";
import * as Layer from "effect/Layer";
import { ContentSafetyRole, makeAccountDataHttpBinding } from "./AccountDataBindingHttp.ts";
import { AnalyzeImageSafety } from "./AnalyzeImageSafety.ts";

/**
 * Implementation of {@link AnalyzeImageSafety} over the distilled `cognitiveservices-content-safety`
 * data plane. Assigns the custom `AzureCognitiveServicesContentSafetyAnalyzeImageRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.AnalyzeImageSafety
 */
export const AnalyzeImageSafetyHttp = Layer.effect(
  AnalyzeImageSafety,
  makeAccountDataHttpBinding({
    tag: "Azure.CognitiveServices.AnalyzeImageSafety",
    operation: contentSafety.ImageOperationsAnalyzeImage,
    grant: ContentSafetyRole.AnalyzeImage,
  }),
);
