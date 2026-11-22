import type * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface AnalyzeDocumentBatchRequest extends Omit<
  documents.DocumentModelsAnalyzeBatchDocumentsRequest,
  "endpoint"
> {}

/**
 * Analyzes batch documents with document model.
 *
 * Binding assigns a custom role (`AzureAIDocumentAnalyzeBatchRole`, one per
 * stack) with exactly the data action
 * `FormRecognizer/documentmodels:analyzebatch/action` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link AnalyzeDocumentBatchHttp}.
 *
 * ### Calling AnalyzeDocumentBatch
 * **Example:** AnalyzeDocumentBatch from a Function
 * ```typescript
 * // init
 * const analyzeDocumentBatch = yield* Azure.CognitiveServices.AnalyzeDocumentBatch(account);
 *
 * // runtime
 * const result = yield* analyzeDocumentBatch({ modelId, resultContainerUrl });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface AnalyzeDocumentBatch extends Binding.Service<
  AnalyzeDocumentBatch,
  "Azure.CognitiveServices.AnalyzeDocumentBatch",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: AnalyzeDocumentBatchRequest,
    ) => Effect.Effect<
      documents.DocumentModelsAnalyzeBatchDocumentsResponse,
      documents.DocumentModelsAnalyzeBatchDocumentsError,
      RuntimeContext
    >
  >
> {}

export const AnalyzeDocumentBatch = Binding.Service<AnalyzeDocumentBatch>(
  "Azure.CognitiveServices.AnalyzeDocumentBatch",
);
