import type * as cu from "@distilled.cloud/azure/ai-content-understanding";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface AnalyzeContentBinaryRequest extends Omit<
  cu.ContentAnalyzersAnalyzeBinaryRequest,
  "endpoint"
> {}

/**
 * Extract content and fields from input.
 *
 * Binding assigns a custom role (`AzureAIContentAnalyzeBinaryRole`, one per
 * stack) with exactly the data action
 * `MultiModalIntelligence/analyzers:analyzebinary/action` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link AnalyzeContentBinaryHttp}.
 *
 * ### Calling AnalyzeContentBinary
 * **Example:** AnalyzeContentBinary from a Function
 * ```typescript
 * // init
 * const analyzeContentBinary = yield* Azure.CognitiveServices.AnalyzeContentBinary(account);
 *
 * // runtime
 * const result = yield* analyzeContentBinary({ analyzerId, body });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface AnalyzeContentBinary extends Binding.Service<
  AnalyzeContentBinary,
  "Azure.CognitiveServices.AnalyzeContentBinary",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: AnalyzeContentBinaryRequest,
    ) => Effect.Effect<
      cu.ContentAnalyzersAnalyzeBinaryResponse,
      cu.ContentAnalyzersAnalyzeBinaryError,
      RuntimeContext
    >
  >
> {}

export const AnalyzeContentBinary = Binding.Service<AnalyzeContentBinary>(
  "Azure.CognitiveServices.AnalyzeContentBinary",
);
