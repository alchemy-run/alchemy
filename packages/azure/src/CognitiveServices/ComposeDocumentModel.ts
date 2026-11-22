import type * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface ComposeDocumentModelRequest extends Omit<
  documents.DocumentModelsComposeModelRequest,
  "endpoint"
> {}

/**
 * Creates a new document model from document types of existing document
 * models.
 *
 * Binding assigns a custom role (`AzureAIDocumentModelsComposeRole`, one per
 * stack) with exactly the data actions
 * `FormRecognizer/documentmodels:compose/action` and
 * `FormRecognizer/documentmodels:compose/write` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link ComposeDocumentModelHttp}.
 *
 * ### Calling ComposeDocumentModel
 * **Example:** ComposeDocumentModel from a Function
 * ```typescript
 * // init
 * const composeDocumentModel = yield* Azure.CognitiveServices.ComposeDocumentModel(account);
 *
 * // runtime
 * const result = yield* composeDocumentModel({ modelId, classifierId, docTypes });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface ComposeDocumentModel extends Binding.Service<
  ComposeDocumentModel,
  "Azure.CognitiveServices.ComposeDocumentModel",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: ComposeDocumentModelRequest,
    ) => Effect.Effect<
      documents.DocumentModelsComposeModelResponse,
      documents.DocumentModelsComposeModelError,
      RuntimeContext
    >
  >
> {}

export const ComposeDocumentModel = Binding.Service<ComposeDocumentModel>(
  "Azure.CognitiveServices.ComposeDocumentModel",
);
