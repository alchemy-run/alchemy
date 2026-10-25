import type * as lang from "@distilled.cloud/azure/cognitiveservices-language-analyze-text";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface SubmitAnalyzeTextJobRequest extends Omit<
  lang.AnalyzeTextSubmitJobRequest,
  "endpoint"
> {}

/**
 * Submit an Azure AI Language long-running analysis job (one or more
 * tasks, e.g. summarization or healthcare) over a batch of documents. The
 * response's `operationLocation` ends in the job ID; read the job with
 * {@link GetAnalyzeTextJob}.
 *
 * Bind it to an Azure AI services account of kind `TextAnalytics` (Language) or `AIServices`.
 * Binding assigns a custom role (`AzureCognitiveServicesLanguageSubmitAnalyzeTextJobRole`, one per stack)
 * with exactly the data action
 * `Microsoft.CognitiveServices/accounts/Language/analyze-text/jobs/action`, on the account only.
 * The smallest built-in role, **Cognitive Services User**, grants every
 * Azure AI services data action and reading the account's keys.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link SubmitAnalyzeTextJobHttp}.
 *
 * ### Calling SubmitAnalyzeTextJob
 * **Example:** SubmitAnalyzeTextJob from a Function
 * ```typescript
 * // init
 * const submitJob = yield* Azure.CognitiveServices.SubmitAnalyzeTextJob(language);
 *
 * // runtime
 * const { operationLocation } = yield* submitJob({
 *   analysisInput: { documents: [{ id: "1", text: "…", language: "en" }] },
 *   tasks: [{ kind: "ExtractiveSummarization", parameters: { sentenceCount: 2 } }],
 * });
 * const jobId = operationLocation!.split("/jobs/")[1]!.split("?")[0]!;
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface SubmitAnalyzeTextJob extends Binding.Service<
  SubmitAnalyzeTextJob,
  "Azure.CognitiveServices.SubmitAnalyzeTextJob",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: SubmitAnalyzeTextJobRequest,
    ) => Effect.Effect<
      lang.AnalyzeTextSubmitJobResponse,
      lang.AnalyzeTextSubmitJobError,
      RuntimeContext
    >
  >
> {}

export const SubmitAnalyzeTextJob = Binding.Service<SubmitAnalyzeTextJob>(
  "Azure.CognitiveServices.SubmitAnalyzeTextJob",
);
