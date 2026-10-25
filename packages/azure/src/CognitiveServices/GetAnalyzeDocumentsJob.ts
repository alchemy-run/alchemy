import type * as documents from "@distilled.cloud/azure/cognitiveservices-language-analyze-documents";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface GetAnalyzeDocumentsJobRequest extends Omit<
  documents.AnalyzeDocumentsJobStatusRequest,
  "endpoint"
> {}

/**
 * Read the status of an Azure AI Language native-document job, and each
 * task's `results` once it has `succeeded`.
 *
 * Bind it to an Azure AI services account of kind `TextAnalytics` (Language) or `AIServices`.
 * Binding assigns a custom role (`AzureCognitiveServicesLanguageReadAnalyzeDocumentsJobRole`, one per stack)
 * with exactly the data action
 * `Microsoft.CognitiveServices/accounts/Language/analyze-documents/jobs/read`, on the account only.
 * The smallest built-in role, **Cognitive Services User**, grants every
 * Azure AI services data action and reading the account's keys.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetAnalyzeDocumentsJobHttp}.
 *
 * ### Calling GetAnalyzeDocumentsJob
 * **Example:** GetAnalyzeDocumentsJob from a Function
 * ```typescript
 * // init
 * const getJob = yield* Azure.CognitiveServices.GetAnalyzeDocumentsJob(language);
 *
 * // runtime
 * const job = yield* getJob({ jobId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface GetAnalyzeDocumentsJob extends Binding.Service<
  GetAnalyzeDocumentsJob,
  "Azure.CognitiveServices.GetAnalyzeDocumentsJob",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: GetAnalyzeDocumentsJobRequest,
    ) => Effect.Effect<
      documents.AnalyzeDocumentsJobState,
      documents.AnalyzeDocumentsJobStatusError,
      RuntimeContext
    >
  >
> {}

export const GetAnalyzeDocumentsJob = Binding.Service<GetAnalyzeDocumentsJob>(
  "Azure.CognitiveServices.GetAnalyzeDocumentsJob",
);
