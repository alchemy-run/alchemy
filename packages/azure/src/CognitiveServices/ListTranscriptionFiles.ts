import type * as stt from "@distilled.cloud/azure/cognitiveservices-speech-to-text";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface ListTranscriptionFilesRequest extends Omit<
  stt.ListTranscriptionFilesRequest,
  "endpoint"
> {}

/**
 * List one page of the result and report files of an Azure AI Speech batch transcription, with SAS download URLs. Pass `nextLink` from the previous page for the next one.
 *
 * Bind it to an Azure AI services account of kind `SpeechServices` or `AIServices`.
 * Binding assigns a custom role (`AzureCognitiveListTranscriptionFilesRole`, one per stack)
 * with exactly the data action
 * `Microsoft.CognitiveServices/accounts/SpeechServices/speechrest/transcriptions/files/read`, on the account only.
 * The smallest built-in role, **Cognitive Services Speech User**, grants every Speech data action.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link ListTranscriptionFilesHttp}.
 *
 * ### Calling ListTranscriptionFiles
 * **Example:** ListTranscriptionFiles from a Function
 * ```typescript
 * // init
 * const listTranscriptionFiles = yield* Azure.CognitiveServices.ListTranscriptionFiles(speech);
 *
 * // runtime
 * const { values } = yield* listTranscriptionFiles({ id });
 * const result = values.find((file) => file.kind === "Transcription");
 * // result?.links?.contentUrl
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface ListTranscriptionFiles extends Binding.Service<
  ListTranscriptionFiles,
  "Azure.CognitiveServices.ListTranscriptionFiles",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: ListTranscriptionFilesRequest,
    ) => Effect.Effect<stt.PaginatedFiles, stt.ListTranscriptionFilesError, RuntimeContext>
  >
> {}

export const ListTranscriptionFiles = Binding.Service<ListTranscriptionFiles>(
  "Azure.CognitiveServices.ListTranscriptionFiles",
);
