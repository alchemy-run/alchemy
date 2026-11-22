import * as stt from "@distilled.cloud/azure/cognitiveservices-speech-to-text";
import * as Layer from "effect/Layer";
import { DeleteTranscription } from "./DeleteTranscription.ts";
import {
  CognitivePath,
  CognitiveRole,
  makeCognitiveHttpBinding,
} from "./SpeechTranslatorVisionHttp.ts";

/**
 * Implementation of {@link DeleteTranscription} over the distilled `cognitiveservices-speech-to-text`
 * data plane. Assigns the custom `AzureCognitiveDeleteTranscriptionRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.DeleteTranscription
 */
export const DeleteTranscriptionHttp = Layer.effect(
  DeleteTranscription,
  makeCognitiveHttpBinding({
    tag: "Azure.CognitiveServices.DeleteTranscription",
    operation: stt.DeleteTranscription,
    path: CognitivePath.speech,
    grant: CognitiveRole.DeleteTranscription,
  }),
);
