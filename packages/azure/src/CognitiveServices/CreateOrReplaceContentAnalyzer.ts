import type * as cu from "@distilled.cloud/azure/ai-content-understanding";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface CreateOrReplaceContentAnalyzerRequest extends Omit<
  cu.ContentAnalyzersCreateOrReplaceRequest,
  "endpoint"
> {}

/**
 * Create a new analyzer asynchronously.
 *
 * Binding assigns a custom role (`AzureAIContentAnalyzersWriteRole`, one per
 * stack) with exactly the data action
 * `MultiModalIntelligence/analyzers/write` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link CreateOrReplaceContentAnalyzerHttp}.
 *
 * ### Calling CreateOrReplaceContentAnalyzer
 * **Example:** CreateOrReplaceContentAnalyzer from a Function
 * ```typescript
 * // init
 * const createOrReplaceContentAnalyzer = yield* Azure.CognitiveServices.CreateOrReplaceContentAnalyzer(account);
 *
 * // runtime
 * const result = yield* createOrReplaceContentAnalyzer({ analyzerId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface CreateOrReplaceContentAnalyzer extends Binding.Service<
  CreateOrReplaceContentAnalyzer,
  "Azure.CognitiveServices.CreateOrReplaceContentAnalyzer",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: CreateOrReplaceContentAnalyzerRequest,
    ) => Effect.Effect<
      cu.ContentAnalyzersCreateOrReplaceResponse,
      cu.ContentAnalyzersCreateOrReplaceError,
      RuntimeContext
    >
  >
> {}

export const CreateOrReplaceContentAnalyzer = Binding.Service<CreateOrReplaceContentAnalyzer>(
  "Azure.CognitiveServices.CreateOrReplaceContentAnalyzer",
);
