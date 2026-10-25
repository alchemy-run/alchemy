import type * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface DeleteDocumentModelRequest extends Omit<
  documents.DeleteDocumentModelModelRequest,
  "endpoint"
> {}

/**
 * Deletes document model.
 *
 * Binding assigns a custom role (`AzureAIDocumentModelsDeleteRole`, one per
 * stack) with exactly the data action `FormRecognizer/documentmodels/delete`
 * (under `Microsoft.CognitiveServices/accounts/`), on the account only. The
 * account needs a custom subdomain (Alchemy sets one by default). The
 * built-in **Azure AI User** and **Cognitive Services User** roles grant
 * every `Microsoft.CognitiveServices/*` data action. On a host with a
 * managed identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link DeleteDocumentModelHttp}.
 *
 * ### Calling DeleteDocumentModel
 * **Example:** DeleteDocumentModel from a Function
 * ```typescript
 * // init
 * const deleteDocumentModel = yield* Azure.CognitiveServices.DeleteDocumentModel(account);
 *
 * // runtime
 * const result = yield* deleteDocumentModel({ modelId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface DeleteDocumentModel extends Binding.Service<
  DeleteDocumentModel,
  "Azure.CognitiveServices.DeleteDocumentModel",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: DeleteDocumentModelRequest,
    ) => Effect.Effect<
      documents.DeleteDocumentModelModelResponse,
      documents.DeleteDocumentModelModelError,
      RuntimeContext
    >
  >
> {}

export const DeleteDocumentModel = Binding.Service<DeleteDocumentModel>(
  "Azure.CognitiveServices.DeleteDocumentModel",
);
