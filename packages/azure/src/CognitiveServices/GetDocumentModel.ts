import type * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface GetDocumentModelRequest extends Omit<
  documents.GetDocumentModelModelRequest,
  "endpoint"
> {}

/**
 * Gets detailed document model information.
 *
 * Binding assigns a custom role (`AzureAIDocumentModelsReadRole`, one per
 * stack) with exactly the data action `FormRecognizer/documentmodels/read`
 * (under `Microsoft.CognitiveServices/accounts/`), on the account only. The
 * account needs a custom subdomain (Alchemy sets one by default). The
 * built-in **Azure AI User** and **Cognitive Services User** roles grant
 * every `Microsoft.CognitiveServices/*` data action. On a host with a
 * managed identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link GetDocumentModelHttp}.
 *
 * ### Calling GetDocumentModel
 * **Example:** GetDocumentModel from a Function
 * ```typescript
 * // init
 * const getDocumentModel = yield* Azure.CognitiveServices.GetDocumentModel(account);
 *
 * // runtime
 * const model = yield* getDocumentModel({ modelId: "prebuilt-invoice" });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface GetDocumentModel extends Binding.Service<
  GetDocumentModel,
  "Azure.CognitiveServices.GetDocumentModel",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: GetDocumentModelRequest,
    ) => Effect.Effect<
      documents.DocumentModelDetails,
      documents.GetDocumentModelModelError,
      RuntimeContext
    >
  >
> {}

export const GetDocumentModel = Binding.Service<GetDocumentModel>(
  "Azure.CognitiveServices.GetDocumentModel",
);
