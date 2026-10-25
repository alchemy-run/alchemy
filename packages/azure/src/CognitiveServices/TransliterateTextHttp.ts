import * as tt from "@distilled.cloud/azure/cognitiveservices-translator-text";
import * as Layer from "effect/Layer";
import {
  CognitivePath,
  CognitiveRole,
  makeCognitiveHttpBinding,
} from "./SpeechTranslatorVisionHttp.ts";
import { TransliterateText } from "./TransliterateText.ts";

/**
 * Implementation of {@link TransliterateText} over the distilled `cognitiveservices-translator-text`
 * data plane. Assigns the custom `AzureCognitiveTransliterateTextRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.TransliterateText
 */
export const TransliterateTextHttp = Layer.effect(
  TransliterateText,
  makeCognitiveHttpBinding({
    tag: "Azure.CognitiveServices.TransliterateText",
    operation: tt.TranslatorTransliterate,
    path: CognitivePath.translator,
    grant: CognitiveRole.TransliterateText,
  }),
);
