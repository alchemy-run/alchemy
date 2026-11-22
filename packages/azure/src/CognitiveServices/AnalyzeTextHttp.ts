import * as lang from "@distilled.cloud/azure/cognitiveservices-language-analyze-text";
import * as Layer from "effect/Layer";
import { LanguageRole, makeAccountDataHttpBinding } from "./AccountDataBindingHttp.ts";
import { AnalyzeText } from "./AnalyzeText.ts";

/**
 * Implementation of {@link AnalyzeText} over the distilled `cognitiveservices-language-analyze-text`
 * data plane. Assigns the custom `AzureCognitiveServicesLanguageAnalyzeTextRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.AnalyzeText
 */
export const AnalyzeTextHttp = Layer.effect(
  AnalyzeText,
  makeAccountDataHttpBinding({
    tag: "Azure.CognitiveServices.AnalyzeText",
    operation: lang.AnalyzeText,
    grant: LanguageRole.AnalyzeText,
  }),
);
