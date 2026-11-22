import * as tt from "@distilled.cloud/azure/cognitiveservices-translator-text";
import * as Layer from "effect/Layer";
import { DetectTextLanguage } from "./DetectTextLanguage.ts";
import {
  CognitivePath,
  CognitiveRole,
  makeCognitiveHttpBinding,
} from "./SpeechTranslatorVisionHttp.ts";

/**
 * Implementation of {@link DetectTextLanguage} over the distilled `cognitiveservices-translator-text`
 * data plane. Assigns the custom `AzureCognitiveDetectTextLanguageRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.DetectTextLanguage
 */
export const DetectTextLanguageHttp = Layer.effect(
  DetectTextLanguage,
  makeCognitiveHttpBinding({
    tag: "Azure.CognitiveServices.DetectTextLanguage",
    operation: tt.TranslatorDetect,
    path: CognitivePath.translator,
    grant: CognitiveRole.DetectTextLanguage,
  }),
);
