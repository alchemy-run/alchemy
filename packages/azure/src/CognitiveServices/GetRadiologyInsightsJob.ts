import type * as health from "@distilled.cloud/azure/ai-health-insights";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface GetRadiologyInsightsJobRequest extends Omit<
  health.GetRadiologyInsightJobRequest,
  "endpoint"
> {}

/**
 * Get Radiology Insights job details Gets the status and details of the
 * Radiology Insights job.
 *
 * Binding assigns a custom role (`AzureAIRadiologyInsightsJobsReadRole`, one
 * per stack) with exactly the data action
 * `HealthInsights/radiology-insights/jobs/read` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link GetRadiologyInsightsJobHttp}.
 *
 * ### Calling GetRadiologyInsightsJob
 * **Example:** GetRadiologyInsightsJob from a Function
 * ```typescript
 * // init
 * const getRadiologyInsightsJob = yield* Azure.CognitiveServices.GetRadiologyInsightsJob(account);
 *
 * // runtime
 * const result = yield* getRadiologyInsightsJob({ id });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface GetRadiologyInsightsJob extends Binding.Service<
  GetRadiologyInsightsJob,
  "Azure.CognitiveServices.GetRadiologyInsightsJob",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: GetRadiologyInsightsJobRequest,
    ) => Effect.Effect<
      health.RadiologyInsightsJob,
      health.GetRadiologyInsightJobError,
      RuntimeContext
    >
  >
> {}

export const GetRadiologyInsightsJob = Binding.Service<GetRadiologyInsightsJob>(
  "Azure.CognitiveServices.GetRadiologyInsightsJob",
);
