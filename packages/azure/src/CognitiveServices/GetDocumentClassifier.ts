import type * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface GetDocumentClassifierRequest extends Omit<
  documents.GetDocumentClassifierClassifierRequest,
  "endpoint"
> {}

/**
 * Gets detailed document classifier information.
 *
 * Binding assigns a custom role (`AzureAIDocumentClassifiersReadRole`, one
 * per stack) with exactly the data action
 * `FormRecognizer/documentclassifiers/read` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link GetDocumentClassifierHttp}.
 *
 * ### Calling GetDocumentClassifier
 * **Example:** GetDocumentClassifier from a Function
 * ```typescript
 * // init
 * const getDocumentClassifier = yield* Azure.CognitiveServices.GetDocumentClassifier(account);
 *
 * // runtime
 * const result = yield* getDocumentClassifier({ classifierId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface GetDocumentClassifier extends Binding.Service<
  GetDocumentClassifier,
  "Azure.CognitiveServices.GetDocumentClassifier",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: GetDocumentClassifierRequest,
    ) => Effect.Effect<
      documents.DocumentClassifierDetails,
      documents.GetDocumentClassifierClassifierError,
      RuntimeContext
    >
  >
> {}

export const GetDocumentClassifier = Binding.Service<GetDocumentClassifier>(
  "Azure.CognitiveServices.GetDocumentClassifier",
);
