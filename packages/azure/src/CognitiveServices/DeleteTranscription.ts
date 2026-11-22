import type * as stt from "@distilled.cloud/azure/cognitiveservices-speech-to-text";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface DeleteTranscriptionRequest extends Omit<
  stt.DeleteTranscriptionRequest,
  "endpoint"
> {}

/**
 * Delete an Azure AI Speech batch transcription and its result files.
 *
 * Bind it to an Azure AI services account of kind `SpeechServices` or `AIServices`.
 * Binding assigns a custom role (`AzureCognitiveDeleteTranscriptionRole`, one per stack)
 * with exactly the data action
 * `Microsoft.CognitiveServices/accounts/SpeechServices/speechrest/transcriptions/delete`, on the account only.
 * The smallest built-in role, **Cognitive Services Speech User**, grants every Speech data action.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link DeleteTranscriptionHttp}.
 *
 * ### Calling DeleteTranscription
 * **Example:** DeleteTranscription from a Function
 * ```typescript
 * // init
 * const deleteTranscription = yield* Azure.CognitiveServices.DeleteTranscription(speech);
 *
 * // runtime
 * yield* deleteTranscription({ id });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface DeleteTranscription extends Binding.Service<
  DeleteTranscription,
  "Azure.CognitiveServices.DeleteTranscription",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: DeleteTranscriptionRequest,
    ) => Effect.Effect<
      stt.DeleteTranscriptionResponse,
      stt.DeleteTranscriptionError,
      RuntimeContext
    >
  >
> {}

export const DeleteTranscription = Binding.Service<DeleteTranscription>(
  "Azure.CognitiveServices.DeleteTranscription",
);
