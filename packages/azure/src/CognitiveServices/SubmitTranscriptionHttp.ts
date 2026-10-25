import * as stt from "@distilled.cloud/azure/cognitiveservices-speech-to-text";
import * as Layer from "effect/Layer";
import {
  CognitivePath,
  CognitiveRole,
  makeCognitiveHttpBinding,
} from "./SpeechTranslatorVisionHttp.ts";
import { SubmitTranscription } from "./SubmitTranscription.ts";

/**
 * Implementation of {@link SubmitTranscription} over the distilled `cognitiveservices-speech-to-text`
 * data plane. Assigns the custom `AzureCognitiveSubmitTranscriptionRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.SubmitTranscription
 */
export const SubmitTranscriptionHttp = Layer.effect(
  SubmitTranscription,
  makeCognitiveHttpBinding({
    tag: "Azure.CognitiveServices.SubmitTranscription",
    operation: stt.SubmitTranscription,
    path: CognitivePath.speech,
    grant: CognitiveRole.SubmitTranscription,
  }),
);
