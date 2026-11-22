import type * as stt from "@distilled.cloud/azure/cognitiveservices-speech-to-text";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface SubmitTranscriptionRequest extends Omit<
  stt.SubmitTranscriptionRequest,
  "endpoint"
> {}

/**
 * Start an Azure AI Speech batch transcription of audio files at public or SAS URLs. The response's `self` URL ends with the transcription ID.
 *
 * Bind it to an Azure AI services account of kind `SpeechServices` or `AIServices`.
 * Binding assigns a custom role (`AzureCognitiveSubmitTranscriptionRole`, one per stack)
 * with exactly the data action
 * `Microsoft.CognitiveServices/accounts/SpeechServices/speechrest/transcriptions/write`, on the account only.
 * The smallest built-in role, **Cognitive Services Speech User**, grants every Speech data action.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link SubmitTranscriptionHttp}.
 *
 * ### Calling SubmitTranscription
 * **Example:** SubmitTranscription from a Function
 * ```typescript
 * // init
 * const submitTranscription = yield* Azure.CognitiveServices.SubmitTranscription(speech);
 *
 * // runtime
 * const job = yield* submitTranscription({
 *   displayName: "call-1234",
 *   locale: "en-US",
 *   contentUrls: ["https://example.com/call-1234.wav"],
 *   properties: { timeToLiveHours: 24 },
 * });
 * const id = job.self!.split("/").pop()!.split("?")[0];
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface SubmitTranscription extends Binding.Service<
  SubmitTranscription,
  "Azure.CognitiveServices.SubmitTranscription",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: SubmitTranscriptionRequest,
    ) => Effect.Effect<
      stt.SubmitTranscriptionResponse,
      stt.SubmitTranscriptionError,
      RuntimeContext
    >
  >
> {}

export const SubmitTranscription = Binding.Service<SubmitTranscription>(
  "Azure.CognitiveServices.SubmitTranscription",
);
