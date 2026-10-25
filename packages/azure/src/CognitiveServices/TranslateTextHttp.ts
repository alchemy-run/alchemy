import * as tt from "@distilled.cloud/azure/cognitiveservices-translator-text";
import * as Layer from "effect/Layer";
import {
  CognitivePath,
  CognitiveRole,
  makeCognitiveHttpBinding,
} from "./SpeechTranslatorVisionHttp.ts";
import { TranslateText } from "./TranslateText.ts";

/**
 * Implementation of {@link TranslateText} over the distilled `cognitiveservices-translator-text`
 * data plane. Assigns the custom `AzureCognitiveTranslateTextRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.TranslateText
 */
export const TranslateTextHttp = Layer.effect(
  TranslateText,
  makeCognitiveHttpBinding({
    tag: "Azure.CognitiveServices.TranslateText",
    operation: tt.TranslatorTranslate,
    path: CognitivePath.translator,
    grant: CognitiveRole.TranslateText,
  }),
);
