import type * as cu from "@distilled.cloud/azure/ai-content-understanding";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface UpdateContentAnalyzerDefaultsRequest extends Omit<
  cu.UpdateContentAnalyzerDefaultsRequest,
  "endpoint"
> {}

/**
 * Update default settings for this Content Understanding resource.
 *
 * Binding assigns a custom role (`AzureAIContentDefaultsWriteRole`, one per
 * stack) with exactly the data action
 * `MultiModalIntelligence/defaults/write` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link UpdateContentAnalyzerDefaultsHttp}.
 *
 * ### Calling UpdateContentAnalyzerDefaults
 * **Example:** UpdateContentAnalyzerDefaults from a Function
 * ```typescript
 * // init
 * const updateContentAnalyzerDefaults = yield* Azure.CognitiveServices.UpdateContentAnalyzerDefaults(account);
 *
 * // runtime
 * const result = yield* updateContentAnalyzerDefaults();
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface UpdateContentAnalyzerDefaults extends Binding.Service<
  UpdateContentAnalyzerDefaults,
  "Azure.CognitiveServices.UpdateContentAnalyzerDefaults",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request?: UpdateContentAnalyzerDefaultsRequest,
    ) => Effect.Effect<
      cu.ContentUnderstandingDefaults,
      cu.UpdateContentAnalyzerDefaultsError,
      RuntimeContext
    >
  >
> {}

export const UpdateContentAnalyzerDefaults = Binding.Service<UpdateContentAnalyzerDefaults>(
  "Azure.CognitiveServices.UpdateContentAnalyzerDefaults",
);
