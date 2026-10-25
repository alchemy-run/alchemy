import * as st from "@distilled.cloud/azure/cognitiveservices-speech-transcription";
import * as Layer from "effect/Layer";
import {
  CognitivePath,
  CognitiveRole,
  makeCognitiveHttpBinding,
} from "./SpeechTranslatorVisionHttp.ts";
import { TranscribeAudio } from "./TranscribeAudio.ts";

/**
 * Implementation of {@link TranscribeAudio} over the distilled `cognitiveservices-speech-transcription`
 * data plane. Assigns the custom `AzureCognitiveTranscribeAudioRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.TranscribeAudio
 */
export const TranscribeAudioHttp = Layer.effect(
  TranscribeAudio,
  makeCognitiveHttpBinding({
    tag: "Azure.CognitiveServices.TranscribeAudio",
    operation: st.Transcribe,
    path: CognitivePath.speech,
    grant: CognitiveRole.TranscribeAudio,
  }),
);
