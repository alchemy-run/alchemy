import * as tt from "@distilled.cloud/azure/cognitiveservices-translator-text";
import * as Layer from "effect/Layer";
import { LookupDictionary } from "./LookupDictionary.ts";
import {
  CognitivePath,
  CognitiveRole,
  makeCognitiveHttpBinding,
} from "./SpeechTranslatorVisionHttp.ts";

/**
 * Implementation of {@link LookupDictionary} over the distilled `cognitiveservices-translator-text`
 * data plane. Assigns the custom `AzureCognitiveLookupDictionaryRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.LookupDictionary
 */
export const LookupDictionaryHttp = Layer.effect(
  LookupDictionary,
  makeCognitiveHttpBinding({
    tag: "Azure.CognitiveServices.LookupDictionary",
    operation: tt.LookupTranslatorDictionary,
    path: CognitivePath.translator,
    grant: CognitiveRole.LookupDictionary,
  }),
);
