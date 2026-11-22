import * as contentSafety from "@distilled.cloud/azure/cognitiveservices-content-safety";
import * as Layer from "effect/Layer";
import { ContentSafetyRole, makeAccountDataHttpBinding } from "./AccountDataBindingHttp.ts";
import { ShieldPrompt } from "./ShieldPrompt.ts";

/**
 * Implementation of {@link ShieldPrompt} over the distilled `cognitiveservices-content-safety`
 * data plane. Assigns the custom `AzureCognitiveServicesContentSafetyShieldPromptRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.ShieldPrompt
 */
export const ShieldPromptHttp = Layer.effect(
  ShieldPrompt,
  makeAccountDataHttpBinding({
    tag: "Azure.CognitiveServices.ShieldPrompt",
    operation: contentSafety.TextOperationsShieldPrompt,
    grant: ContentSafetyRole.ShieldPrompt,
  }),
);
