import type * as health from "@distilled.cloud/azure/ai-health-insights";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface CreateRadiologyInsightsJobRequest extends Omit<
  health.CreateRadiologyInsightJobRequest,
  "endpoint"
> {}

/**
 * Create Radiology Insights job Creates a Radiology Insights job with the
 * given request body.
 *
 * Binding assigns a custom role (`AzureAIRadiologyInsightsJobsWriteRole`,
 * one per stack) with exactly the data action
 * `HealthInsights/radiology-insights/jobs/write` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link CreateRadiologyInsightsJobHttp}.
 *
 * ### Calling CreateRadiologyInsightsJob
 * **Example:** CreateRadiologyInsightsJob from a Function
 * ```typescript
 * // init
 * const createRadiologyInsightsJob = yield* Azure.CognitiveServices.CreateRadiologyInsightsJob(account);
 *
 * // runtime
 * const result = yield* createRadiologyInsightsJob({ id });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface CreateRadiologyInsightsJob extends Binding.Service<
  CreateRadiologyInsightsJob,
  "Azure.CognitiveServices.CreateRadiologyInsightsJob",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: CreateRadiologyInsightsJobRequest,
    ) => Effect.Effect<
      health.RadiologyInsightsJob,
      health.CreateRadiologyInsightJobError,
      RuntimeContext
    >
  >
> {}

export const CreateRadiologyInsightsJob = Binding.Service<CreateRadiologyInsightsJob>(
  "Azure.CognitiveServices.CreateRadiologyInsightsJob",
);
