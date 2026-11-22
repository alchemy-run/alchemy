import type * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface GetDocumentClassifierCopyToOperationRequest extends Omit<
  documents.MiscellaneousOperationsGetDocumentClassifierCopyToOperationRequest,
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
 * {@link GetDocumentClassifierCopyToOperationHttp}.
 *
 * ### Calling GetDocumentClassifierCopyToOperation
 * **Example:** GetDocumentClassifierCopyToOperation from a Function
 * ```typescript
 * // init
 * const getDocumentClassifierCopyToOperation = yield* Azure.CognitiveServices.GetDocumentClassifierCopyToOperation(account);
 *
 * // runtime
 * const result = yield* getDocumentClassifierCopyToOperation({ operationId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface GetDocumentClassifierCopyToOperation extends Binding.Service<
  GetDocumentClassifierCopyToOperation,
  "Azure.CognitiveServices.GetDocumentClassifierCopyToOperation",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: GetDocumentClassifierCopyToOperationRequest,
    ) => Effect.Effect<
      documents.MiscellaneousOperationsGetDocumentClassifierCopyToOperationResponse,
      documents.MiscellaneousOperationsGetDocumentClassifierCopyToOperationError,
      RuntimeContext
    >
  >
> {}

export const GetDocumentClassifierCopyToOperation =
  Binding.Service<GetDocumentClassifierCopyToOperation>(
    "Azure.CognitiveServices.GetDocumentClassifierCopyToOperation",
  );
