import type * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface GetDocumentClassifyResultRequest extends Omit<
  documents.GetDocumentClassifierClassifyResultRequest,
  "endpoint"
> {}

/**
 * Gets the result of document classifier.
 *
 * Binding assigns a custom role (`AzureAIDocumentClassifyResultsReadRole`,
 * one per stack) with exactly the data action
 * `FormRecognizer/documentclassifiers/analyzeresults/read` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link GetDocumentClassifyResultHttp}.
 *
 * ### Calling GetDocumentClassifyResult
 * **Example:** GetDocumentClassifyResult from a Function
 * ```typescript
 * // init
 * const getDocumentClassifyResult = yield* Azure.CognitiveServices.GetDocumentClassifyResult(account);
 *
 * // runtime
 * const result = yield* getDocumentClassifyResult({ classifierId, resultId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface GetDocumentClassifyResult extends Binding.Service<
  GetDocumentClassifyResult,
  "Azure.CognitiveServices.GetDocumentClassifyResult",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: GetDocumentClassifyResultRequest,
    ) => Effect.Effect<
      documents.AnalyzeOperation,
      documents.GetDocumentClassifierClassifyResultError,
      RuntimeContext
    >
  >
> {}

export const GetDocumentClassifyResult = Binding.Service<GetDocumentClassifyResult>(
  "Azure.CognitiveServices.GetDocumentClassifyResult",
);
