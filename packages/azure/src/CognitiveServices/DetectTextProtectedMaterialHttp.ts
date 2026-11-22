import * as contentSafety from "@distilled.cloud/azure/cognitiveservices-content-safety";
import * as Layer from "effect/Layer";
import { ContentSafetyRole, makeAccountDataHttpBinding } from "./AccountDataBindingHttp.ts";
import { DetectTextProtectedMaterial } from "./DetectTextProtectedMaterial.ts";

/**
 * Implementation of {@link DetectTextProtectedMaterial} over the distilled `cognitiveservices-content-safety`
 * data plane. Assigns the custom `AzureCognitiveServicesContentSafetyDetectProtectedMaterialRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.DetectTextProtectedMaterial
 */
export const DetectTextProtectedMaterialHttp = Layer.effect(
  DetectTextProtectedMaterial,
  makeAccountDataHttpBinding({
    tag: "Azure.CognitiveServices.DetectTextProtectedMaterial",
    operation: contentSafety.TextOperationsDetectTextProtectedMaterial,
    grant: ContentSafetyRole.DetectProtectedMaterial,
  }),
);
