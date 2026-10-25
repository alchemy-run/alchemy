import type * as cu from "@distilled.cloud/azure/ai-content-understanding";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface GrantContentAnalyzerCopyAuthorizationRequest extends Omit<
  cu.ContentAnalyzersGrantCopyAuthorizationRequest,
  "endpoint"
> {}

/**
 * Get authorization for copying this analyzer to another location.
 *
 * Binding assigns a custom role (`AzureAIContentAnalyzerGrantCopyRole`, one
 * per stack) with exactly the data action
 * `MultiModalIntelligence/analyzers:grantCopyAuthorization/action` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link GrantContentAnalyzerCopyAuthorizationHttp}.
 *
 * ### Calling GrantContentAnalyzerCopyAuthorization
 * **Example:** GrantContentAnalyzerCopyAuthorization from a Function
 * ```typescript
 * // init
 * const grantContentAnalyzerCopyAuthorization = yield* Azure.CognitiveServices.GrantContentAnalyzerCopyAuthorization(account);
 *
 * // runtime
 * const result = yield* grantContentAnalyzerCopyAuthorization({ analyzerId, targetAzureResourceId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface GrantContentAnalyzerCopyAuthorization extends Binding.Service<
  GrantContentAnalyzerCopyAuthorization,
  "Azure.CognitiveServices.GrantContentAnalyzerCopyAuthorization",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: GrantContentAnalyzerCopyAuthorizationRequest,
    ) => Effect.Effect<
      cu.CopyAuthorization,
      cu.ContentAnalyzersGrantCopyAuthorizationError,
      RuntimeContext
    >
  >
> {}

export const GrantContentAnalyzerCopyAuthorization =
  Binding.Service<GrantContentAnalyzerCopyAuthorization>(
    "Azure.CognitiveServices.GrantContentAnalyzerCopyAuthorization",
  );
