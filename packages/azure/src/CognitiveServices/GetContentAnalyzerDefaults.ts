import type * as cu from "@distilled.cloud/azure/ai-content-understanding";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface GetContentAnalyzerDefaultsRequest extends Omit<
  cu.GetContentAnalyzerDefaultsRequest,
  "endpoint"
> {}

/**
 * Return default settings for this Content Understanding resource.
 *
 * Binding assigns a custom role (`AzureAIContentDefaultsReadRole`, one per
 * stack) with exactly the data action `MultiModalIntelligence/defaults/read`
 * (under `Microsoft.CognitiveServices/accounts/`), on the account only. The
 * account needs a custom subdomain (Alchemy sets one by default). The
 * built-in **Azure AI User** and **Cognitive Services User** roles grant
 * every `Microsoft.CognitiveServices/*` data action. On a host with a
 * managed identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link GetContentAnalyzerDefaultsHttp}.
 *
 * ### Calling GetContentAnalyzerDefaults
 * **Example:** GetContentAnalyzerDefaults from a Function
 * ```typescript
 * // init
 * const getContentAnalyzerDefaults = yield* Azure.CognitiveServices.GetContentAnalyzerDefaults(account);
 *
 * // runtime
 * const result = yield* getContentAnalyzerDefaults();
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface GetContentAnalyzerDefaults extends Binding.Service<
  GetContentAnalyzerDefaults,
  "Azure.CognitiveServices.GetContentAnalyzerDefaults",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request?: GetContentAnalyzerDefaultsRequest,
    ) => Effect.Effect<
      cu.ContentUnderstandingDefaults,
      cu.GetContentAnalyzerDefaultsError,
      RuntimeContext
    >
  >
> {}

export const GetContentAnalyzerDefaults = Binding.Service<GetContentAnalyzerDefaults>(
  "Azure.CognitiveServices.GetContentAnalyzerDefaults",
);
