import type * as documents from "@distilled.cloud/azure/cognitiveservices-language-analyze-documents";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface CancelAnalyzeDocumentsJobRequest extends Omit<
  documents.AnalyzeDocumentsCancelJobRequest,
  "endpoint"
> {}

/**
 * Cancel a running Azure AI Language native-document job.
 *
 * Bind it to an Azure AI services account of kind `TextAnalytics` (Language) or `AIServices`.
 * Binding assigns a custom role (`AzureCognitiveServicesLanguageCancelAnalyzeDocumentsJobRole`, one per stack)
 * with exactly the data action
 * `Microsoft.CognitiveServices/accounts/Language/analyze-documents/jobscancel/action`, on the account only.
 * The smallest built-in role, **Cognitive Services User**, grants every
 * Azure AI services data action and reading the account's keys.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link CancelAnalyzeDocumentsJobHttp}.
 *
 * ### Calling CancelAnalyzeDocumentsJob
 * **Example:** CancelAnalyzeDocumentsJob from a Function
 * ```typescript
 * // init
 * const cancelJob = yield* Azure.CognitiveServices.CancelAnalyzeDocumentsJob(language);
 *
 * // runtime
 * yield* cancelJob({ jobId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface CancelAnalyzeDocumentsJob extends Binding.Service<
  CancelAnalyzeDocumentsJob,
  "Azure.CognitiveServices.CancelAnalyzeDocumentsJob",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: CancelAnalyzeDocumentsJobRequest,
    ) => Effect.Effect<
      documents.AnalyzeDocumentsCancelJobResponse,
      documents.AnalyzeDocumentsCancelJobError,
      RuntimeContext
    >
  >
> {}

export const CancelAnalyzeDocumentsJob = Binding.Service<CancelAnalyzeDocumentsJob>(
  "Azure.CognitiveServices.CancelAnalyzeDocumentsJob",
);
