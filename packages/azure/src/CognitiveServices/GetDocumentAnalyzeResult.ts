import type * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface GetDocumentAnalyzeResultRequest extends Omit<
  documents.GetDocumentModelAnalyzeResultRequest,
  "endpoint"
> {}

/**
 * Gets the result of document analysis.
 *
 * Binding assigns a custom role (`AzureAIDocumentAnalyzeResultsReadRole`,
 * one per stack) with exactly the data action
 * `FormRecognizer/documentmodels/analyzeresults/read` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link GetDocumentAnalyzeResultHttp}.
 *
 * ### Calling GetDocumentAnalyzeResult
 * **Example:** GetDocumentAnalyzeResult from a Function
 * ```typescript
 * // init
 * const getDocumentAnalyzeResult = yield* Azure.CognitiveServices.GetDocumentAnalyzeResult(account);
 *
 * // runtime
 * const result = yield* getDocumentAnalyzeResult({ modelId: "prebuilt-read", resultId });
 * const text = result.analyzeResult?.content;
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface GetDocumentAnalyzeResult extends Binding.Service<
  GetDocumentAnalyzeResult,
  "Azure.CognitiveServices.GetDocumentAnalyzeResult",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: GetDocumentAnalyzeResultRequest,
    ) => Effect.Effect<
      documents.AnalyzeOperation,
      documents.GetDocumentModelAnalyzeResultError,
      RuntimeContext
    >
  >
> {}

export const GetDocumentAnalyzeResult = Binding.Service<GetDocumentAnalyzeResult>(
  "Azure.CognitiveServices.GetDocumentAnalyzeResult",
);
