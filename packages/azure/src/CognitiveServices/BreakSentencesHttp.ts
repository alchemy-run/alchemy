import * as tt from "@distilled.cloud/azure/cognitiveservices-translator-text";
import * as Layer from "effect/Layer";
import { BreakSentences } from "./BreakSentences.ts";
import {
  CognitivePath,
  CognitiveRole,
  makeCognitiveHttpBinding,
} from "./SpeechTranslatorVisionHttp.ts";

/**
 * Implementation of {@link BreakSentences} over the distilled `cognitiveservices-translator-text`
 * data plane. Assigns the custom `AzureCognitiveBreakSentencesRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.BreakSentences
 */
export const BreakSentencesHttp = Layer.effect(
  BreakSentences,
  makeCognitiveHttpBinding({
    tag: "Azure.CognitiveServices.BreakSentences",
    operation: tt.TranslatorBreakSentence,
    path: CognitivePath.translator,
    grant: CognitiveRole.BreakSentences,
  }),
);
