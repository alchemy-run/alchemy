import type * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface AnalyzeDocumentFromStreamRequest extends Omit<
  documents.DocumentModelsAnalyzeDocumentFromStreamRequest,
  "endpoint"
> {}

/**
 * Analyzes document with document model.
 *
 * Binding assigns a custom role (`AzureAIDocumentAnalyzeRole`, one per
 * stack) with exactly the data action
 * `FormRecognizer/documentmodels:analyze/action` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link AnalyzeDocumentFromStreamHttp}.
 *
 * ### Calling AnalyzeDocumentFromStream
 * **Example:** AnalyzeDocumentFromStream from a Function
 * ```typescript
 * // init
 * const analyzeDocumentFromStream = yield* Azure.CognitiveServices.AnalyzeDocumentFromStream(account);
 *
 * // runtime
 * const result = yield* analyzeDocumentFromStream({ modelId, body });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface AnalyzeDocumentFromStream extends Binding.Service<
  AnalyzeDocumentFromStream,
  "Azure.CognitiveServices.AnalyzeDocumentFromStream",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: AnalyzeDocumentFromStreamRequest,
    ) => Effect.Effect<
      documents.DocumentModelsAnalyzeDocumentFromStreamResponse,
      documents.DocumentModelsAnalyzeDocumentFromStreamError,
      RuntimeContext
    >
  >
> {}

export const AnalyzeDocumentFromStream = Binding.Service<AnalyzeDocumentFromStream>(
  "Azure.CognitiveServices.AnalyzeDocumentFromStream",
);
