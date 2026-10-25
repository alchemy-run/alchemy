import * as tt from "@distilled.cloud/azure/cognitiveservices-translator-text";
import * as Layer from "effect/Layer";
import { ListTranslatorLanguages } from "./ListTranslatorLanguages.ts";
import {
  CognitivePath,
  CognitiveRole,
  makeCognitiveHttpBinding,
} from "./SpeechTranslatorVisionHttp.ts";

/**
 * Implementation of {@link ListTranslatorLanguages} over the distilled `cognitiveservices-translator-text`
 * data plane. Assigns the custom `AzureCognitiveListTranslatorLanguagesRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.ListTranslatorLanguages
 */
export const ListTranslatorLanguagesHttp = Layer.effect(
  ListTranslatorLanguages,
  makeCognitiveHttpBinding({
    tag: "Azure.CognitiveServices.ListTranslatorLanguages",
    operation: tt.TranslatorLanguages,
    path: CognitivePath.translator,
    grant: CognitiveRole.ListTranslatorLanguages,
  }),
);
