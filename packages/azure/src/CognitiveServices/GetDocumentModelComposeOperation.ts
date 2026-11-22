import type * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface GetDocumentModelComposeOperationRequest extends Omit<
  documents.GetMiscellaneousOperationDocumentModelComposeOperationRequest,
  "endpoint"
> {}

/**
 * Gets operation info.
 *
 * Binding assigns a custom role (`AzureAIDocumentOperationsReadRole`, one
 * per stack) with exactly the data action `FormRecognizer/operations/read`
 * (under `Microsoft.CognitiveServices/accounts/`), on the account only. The
 * account needs a custom subdomain (Alchemy sets one by default). The
 * built-in **Azure AI User** and **Cognitive Services User** roles grant
 * every `Microsoft.CognitiveServices/*` data action. On a host with a
 * managed identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link GetDocumentModelComposeOperationHttp}.
 *
 * ### Calling GetDocumentModelComposeOperation
 * **Example:** GetDocumentModelComposeOperation from a Function
 * ```typescript
 * // init
 * const getDocumentModelComposeOperation = yield* Azure.CognitiveServices.GetDocumentModelComposeOperation(account);
 *
 * // runtime
 * const result = yield* getDocumentModelComposeOperation({ operationId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface GetDocumentModelComposeOperation extends Binding.Service<
  GetDocumentModelComposeOperation,
  "Azure.CognitiveServices.GetDocumentModelComposeOperation",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: GetDocumentModelComposeOperationRequest,
    ) => Effect.Effect<
      documents.GetMiscellaneousOperationDocumentModelComposeOperationResponse,
      documents.GetMiscellaneousOperationDocumentModelComposeOperationError,
      RuntimeContext
    >
  >
> {}

export const GetDocumentModelComposeOperation = Binding.Service<GetDocumentModelComposeOperation>(
  "Azure.CognitiveServices.GetDocumentModelComposeOperation",
);
