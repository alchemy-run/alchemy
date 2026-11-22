import * as tt from "@distilled.cloud/azure/cognitiveservices-translator-text";
import * as Layer from "effect/Layer";
import { LookupDictionaryExamples } from "./LookupDictionaryExamples.ts";
import {
  CognitivePath,
  CognitiveRole,
  makeCognitiveHttpBinding,
} from "./SpeechTranslatorVisionHttp.ts";

/**
 * Implementation of {@link LookupDictionaryExamples} over the distilled `cognitiveservices-translator-text`
 * data plane. Assigns the custom `AzureCognitiveLookupDictionaryExamplesRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.LookupDictionaryExamples
 */
export const LookupDictionaryExamplesHttp = Layer.effect(
  LookupDictionaryExamples,
  makeCognitiveHttpBinding({
    tag: "Azure.CognitiveServices.LookupDictionaryExamples",
    operation: tt.TranslatorDictionaryExamples,
    path: CognitivePath.translator,
    grant: CognitiveRole.LookupDictionaryExamples,
  }),
);
