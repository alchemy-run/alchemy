import type * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface AnalyzeDocumentRequest extends Omit<
  documents.DocumentModelsAnalyzeDocumentRequest,
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
 * {@link AnalyzeDocumentHttp}.
 *
 * ### Calling AnalyzeDocument
 * **Example:** AnalyzeDocument from a Function
 * ```typescript
 * // init
 * const analyzeDocument = yield* Azure.CognitiveServices.AnalyzeDocument(account);
 *
 * // runtime
 * const { operationLocation } = yield* analyzeDocument({
 *   modelId: "prebuilt-read",
 *   urlSource: "https://example.com/receipt.png",
 * });
 * const resultId = operationLocation?.split("/analyzeResults/")[1]?.split("?")[0];
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface AnalyzeDocument extends Binding.Service<
  AnalyzeDocument,
  "Azure.CognitiveServices.AnalyzeDocument",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: AnalyzeDocumentRequest,
    ) => Effect.Effect<
      documents.DocumentModelsAnalyzeDocumentResponse,
      documents.DocumentModelsAnalyzeDocumentError,
      RuntimeContext
    >
  >
> {}

export const AnalyzeDocument = Binding.Service<AnalyzeDocument>(
  "Azure.CognitiveServices.AnalyzeDocument",
);
