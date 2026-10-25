import type * as st from "@distilled.cloud/azure/cognitiveservices-speech-transcription";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface TranscribeAudioRequest extends Omit<st.TranscribeRequest, "endpoint"> {}

/**
 * Transcribe an audio file synchronously with Azure AI Speech fast transcription: send the audio bytes, or a URL in `definition.audioUrl`.
 *
 * Bind it to an Azure AI services account of kind `SpeechServices` or `AIServices`.
 * Binding assigns a custom role (`AzureCognitiveTranscribeAudioRole`, one per stack)
 * with exactly the data action
 * `Microsoft.CognitiveServices/accounts/SpeechServices/speechrest/transcriptions/action`, on the account only.
 * The smallest built-in role, **Cognitive Services Speech User**, grants every Speech data action.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link TranscribeAudioHttp}.
 *
 * ### Calling TranscribeAudio
 * **Example:** TranscribeAudio from a Function
 * ```typescript
 * // init
 * const transcribeAudio = yield* Azure.CognitiveServices.TranscribeAudio(speech);
 *
 * // runtime
 * const result = yield* transcribeAudio({
 *   definition: { locales: ["en-US"] },
 *   audio: wavBytes, // Uint8Array
 * });
 * // result.combinedPhrases[0].text
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface TranscribeAudio extends Binding.Service<
  TranscribeAudio,
  "Azure.CognitiveServices.TranscribeAudio",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: TranscribeAudioRequest,
    ) => Effect.Effect<st.TranscriptionResult, st.TranscribeError, RuntimeContext>
  >
> {}

export const TranscribeAudio = Binding.Service<TranscribeAudio>(
  "Azure.CognitiveServices.TranscribeAudio",
);
