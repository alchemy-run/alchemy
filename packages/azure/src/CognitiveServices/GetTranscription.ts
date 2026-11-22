import type * as stt from "@distilled.cloud/azure/cognitiveservices-speech-to-text";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface GetTranscriptionRequest extends Omit<stt.GetTranscriptionRequest, "endpoint"> {}

/**
 * Read an Azure AI Speech batch transcription and its status (`NotStarted`, `Running`, `Succeeded`, `Failed`).
 *
 * Bind it to an Azure AI services account of kind `SpeechServices` or `AIServices`.
 * Binding assigns a custom role (`AzureCognitiveGetTranscriptionRole`, one per stack)
 * with exactly the data action
 * `Microsoft.CognitiveServices/accounts/SpeechServices/speechrest/transcriptions/read`, on the account only.
 * The smallest built-in role, **Cognitive Services Speech User**, grants every Speech data action.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetTranscriptionHttp}.
 *
 * ### Calling GetTranscription
 * **Example:** GetTranscription from a Function
 * ```typescript
 * // init
 * const getTranscription = yield* Azure.CognitiveServices.GetTranscription(speech);
 *
 * // runtime
 * const { status } = yield* getTranscription({ id });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface GetTranscription extends Binding.Service<
  GetTranscription,
  "Azure.CognitiveServices.GetTranscription",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: GetTranscriptionRequest,
    ) => Effect.Effect<stt.GetTranscriptionResponse, stt.GetTranscriptionError, RuntimeContext>
  >
> {}

export const GetTranscription = Binding.Service<GetTranscription>(
  "Azure.CognitiveServices.GetTranscription",
);
