import type * as lang from "@distilled.cloud/azure/cognitiveservices-language-analyze-text";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface GetAnalyzeTextJobRequest extends Omit<
  lang.AnalyzeTextJobStatusRequest,
  "endpoint"
> {}

/**
 * Read the status of an Azure AI Language analysis job, and each task's
 * `results` once it has `succeeded`.
 *
 * Bind it to an Azure AI services account of kind `TextAnalytics` (Language) or `AIServices`.
 * Binding assigns a custom role (`AzureCognitiveServicesLanguageReadAnalyzeTextJobRole`, one per stack)
 * with exactly the data action
 * `Microsoft.CognitiveServices/accounts/Language/analyze-text/jobs/read`, on the account only.
 * The smallest built-in role, **Cognitive Services User**, grants every
 * Azure AI services data action and reading the account's keys.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetAnalyzeTextJobHttp}.
 *
 * ### Calling GetAnalyzeTextJob
 * **Example:** GetAnalyzeTextJob from a Function
 * ```typescript
 * // init
 * const getJob = yield* Azure.CognitiveServices.GetAnalyzeTextJob(language);
 *
 * // runtime
 * const job = yield* getJob({ jobId });
 * // job.status → "running" | "succeeded" | …; job.tasks.items[0].results
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface GetAnalyzeTextJob extends Binding.Service<
  GetAnalyzeTextJob,
  "Azure.CognitiveServices.GetAnalyzeTextJob",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: GetAnalyzeTextJobRequest,
    ) => Effect.Effect<lang.AnalyzeTextJobState, lang.AnalyzeTextJobStatusError, RuntimeContext>
  >
> {}

export const GetAnalyzeTextJob = Binding.Service<GetAnalyzeTextJob>(
  "Azure.CognitiveServices.GetAnalyzeTextJob",
);
