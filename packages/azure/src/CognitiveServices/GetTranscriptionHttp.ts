import * as stt from "@distilled.cloud/azure/cognitiveservices-speech-to-text";
import * as Layer from "effect/Layer";
import { GetTranscription } from "./GetTranscription.ts";
import {
  CognitivePath,
  CognitiveRole,
  makeCognitiveHttpBinding,
} from "./SpeechTranslatorVisionHttp.ts";

/**
 * Implementation of {@link GetTranscription} over the distilled `cognitiveservices-speech-to-text`
 * data plane. Assigns the custom `AzureCognitiveGetTranscriptionRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetTranscription
 */
export const GetTranscriptionHttp = Layer.effect(
  GetTranscription,
  makeCognitiveHttpBinding({
    tag: "Azure.CognitiveServices.GetTranscription",
    operation: stt.GetTranscription,
    path: CognitivePath.speech,
    grant: CognitiveRole.GetTranscription,
  }),
);
