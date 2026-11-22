import type * as lang from "@distilled.cloud/azure/cognitiveservices-language-analyze-text";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface CancelAnalyzeTextJobRequest extends Omit<
  lang.AnalyzeTextCancelJobRequest,
  "endpoint"
> {}

/**
 * Cancel a running Azure AI Language analysis job. The job moves to
 * `cancelling`, then `cancelled`.
 *
 * Bind it to an Azure AI services account of kind `TextAnalytics` (Language) or `AIServices`.
 * Binding assigns a custom role (`AzureCognitiveServicesLanguageCancelAnalyzeTextJobRole`, one per stack)
 * with exactly the data action
 * `Microsoft.CognitiveServices/accounts/Language/analyze-text/jobscancel/action`, on the account only.
 * The smallest built-in role, **Cognitive Services User**, grants every
 * Azure AI services data action and reading the account's keys.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link CancelAnalyzeTextJobHttp}.
 *
 * ### Calling CancelAnalyzeTextJob
 * **Example:** CancelAnalyzeTextJob from a Function
 * ```typescript
 * // init
 * const cancelJob = yield* Azure.CognitiveServices.CancelAnalyzeTextJob(language);
 *
 * // runtime
 * yield* cancelJob({ jobId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface CancelAnalyzeTextJob extends Binding.Service<
  CancelAnalyzeTextJob,
  "Azure.CognitiveServices.CancelAnalyzeTextJob",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: CancelAnalyzeTextJobRequest,
    ) => Effect.Effect<
      lang.AnalyzeTextCancelJobResponse,
      lang.AnalyzeTextCancelJobError,
      RuntimeContext
    >
  >
> {}

export const CancelAnalyzeTextJob = Binding.Service<CancelAnalyzeTextJob>(
  "Azure.CognitiveServices.CancelAnalyzeTextJob",
);
