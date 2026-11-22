import * as stt from "@distilled.cloud/azure/cognitiveservices-speech-to-text";
import * as Layer from "effect/Layer";
import { ListTranscriptionFiles } from "./ListTranscriptionFiles.ts";
import {
  CognitivePath,
  CognitiveRole,
  makeCognitiveHttpBinding,
} from "./SpeechTranslatorVisionHttp.ts";

/**
 * Implementation of {@link ListTranscriptionFiles} over the distilled `cognitiveservices-speech-to-text`
 * data plane. Assigns the custom `AzureCognitiveListTranscriptionFilesRole` on the account.
 *
 * @layer
 * @provides Azure.CognitiveServices.ListTranscriptionFiles
 */
export const ListTranscriptionFilesHttp = Layer.effect(
  ListTranscriptionFiles,
  makeCognitiveHttpBinding({
    tag: "Azure.CognitiveServices.ListTranscriptionFiles",
    operation: stt.ListTranscriptionFiles,
    path: CognitivePath.speech,
    grant: CognitiveRole.ListTranscriptionFiles,
  }),
);
