import type * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface GetDocumentAnalyzeResultFigureRequest extends Omit<
  documents.GetDocumentModelAnalyzeResultFigureRequest,
  "endpoint"
> {}

/**
 * Gets the generated cropped image of specified figure from document
 * analysis.
 *
 * Binding assigns a custom role
 * (`AzureAIDocumentAnalyzeResultFiguresReadRole`, one per stack) with
 * exactly the data action
 * `FormRecognizer/documentmodels/analyzeresults/figures/read` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link GetDocumentAnalyzeResultFigureHttp}.
 *
 * ### Calling GetDocumentAnalyzeResultFigure
 * **Example:** GetDocumentAnalyzeResultFigure from a Function
 * ```typescript
 * // init
 * const getDocumentAnalyzeResultFigure = yield* Azure.CognitiveServices.GetDocumentAnalyzeResultFigure(account);
 *
 * // runtime
 * const result = yield* getDocumentAnalyzeResultFigure({ modelId, resultId, figureId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface GetDocumentAnalyzeResultFigure extends Binding.Service<
  GetDocumentAnalyzeResultFigure,
  "Azure.CognitiveServices.GetDocumentAnalyzeResultFigure",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: GetDocumentAnalyzeResultFigureRequest,
    ) => Effect.Effect<
      documents.GetDocumentModelAnalyzeResultFigureResponse,
      documents.GetDocumentModelAnalyzeResultFigureError,
      RuntimeContext
    >
  >
> {}

export const GetDocumentAnalyzeResultFigure = Binding.Service<GetDocumentAnalyzeResultFigure>(
  "Azure.CognitiveServices.GetDocumentAnalyzeResultFigure",
);
