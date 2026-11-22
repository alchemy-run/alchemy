import type * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface GetDocumentAnalyzeResultPdfRequest extends Omit<
  documents.GetDocumentModelAnalyzeResultPdfRequest,
  "endpoint"
> {}

/**
 * Gets the generated searchable PDF output from document analysis.
 *
 * Binding assigns a custom role (`AzureAIDocumentAnalyzeResultPdfReadRole`,
 * one per stack) with exactly the data action
 * `FormRecognizer/documentmodels/analyzeresults/pdf/read` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link GetDocumentAnalyzeResultPdfHttp}.
 *
 * ### Calling GetDocumentAnalyzeResultPdf
 * **Example:** GetDocumentAnalyzeResultPdf from a Function
 * ```typescript
 * // init
 * const getDocumentAnalyzeResultPdf = yield* Azure.CognitiveServices.GetDocumentAnalyzeResultPdf(account);
 *
 * // runtime
 * const result = yield* getDocumentAnalyzeResultPdf({ modelId, resultId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface GetDocumentAnalyzeResultPdf extends Binding.Service<
  GetDocumentAnalyzeResultPdf,
  "Azure.CognitiveServices.GetDocumentAnalyzeResultPdf",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: GetDocumentAnalyzeResultPdfRequest,
    ) => Effect.Effect<
      documents.GetDocumentModelAnalyzeResultPdfResponse,
      documents.GetDocumentModelAnalyzeResultPdfError,
      RuntimeContext
    >
  >
> {}

export const GetDocumentAnalyzeResultPdf = Binding.Service<GetDocumentAnalyzeResultPdf>(
  "Azure.CognitiveServices.GetDocumentAnalyzeResultPdf",
);
