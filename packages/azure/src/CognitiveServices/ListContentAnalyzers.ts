import type * as cu from "@distilled.cloud/azure/ai-content-understanding";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface ListContentAnalyzersRequest extends Omit<
  cu.ListContentAnalyzersRequest,
  "endpoint"
> {}

/**
 * List analyzers.
 *
 * Binding assigns a custom role (`AzureAIContentAnalyzersReadRole`, one per
 * stack) with exactly the data action
 * `MultiModalIntelligence/analyzers/read` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link ListContentAnalyzersHttp}.
 *
 * ### Calling ListContentAnalyzers
 * **Example:** ListContentAnalyzers from a Function
 * ```typescript
 * // init
 * const listContentAnalyzers = yield* Azure.CognitiveServices.ListContentAnalyzers(account);
 *
 * // runtime
 * const { value } = yield* listContentAnalyzers();
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface ListContentAnalyzers extends Binding.Service<
  ListContentAnalyzers,
  "Azure.CognitiveServices.ListContentAnalyzers",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request?: ListContentAnalyzersRequest,
    ) => Effect.Effect<cu.PagedContentAnalyzer, cu.ListContentAnalyzersError, RuntimeContext>
  >
> {}

export const ListContentAnalyzers = Binding.Service<ListContentAnalyzers>(
  "Azure.CognitiveServices.ListContentAnalyzers",
);
