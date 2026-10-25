import type * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface GetDocumentIntelligenceOperationRequest extends Omit<
  documents.GetMiscellaneousOperationOperationRequest,
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
 * {@link GetDocumentIntelligenceOperationHttp}.
 *
 * ### Calling GetDocumentIntelligenceOperation
 * **Example:** GetDocumentIntelligenceOperation from a Function
 * ```typescript
 * // init
 * const getDocumentIntelligenceOperation = yield* Azure.CognitiveServices.GetDocumentIntelligenceOperation(account);
 *
 * // runtime
 * const result = yield* getDocumentIntelligenceOperation({ operationId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface GetDocumentIntelligenceOperation extends Binding.Service<
  GetDocumentIntelligenceOperation,
  "Azure.CognitiveServices.GetDocumentIntelligenceOperation",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: GetDocumentIntelligenceOperationRequest,
    ) => Effect.Effect<
      documents.DocumentIntelligenceOperationDetails,
      documents.GetMiscellaneousOperationOperationError,
      RuntimeContext
    >
  >
> {}

export const GetDocumentIntelligenceOperation = Binding.Service<GetDocumentIntelligenceOperation>(
  "Azure.CognitiveServices.GetDocumentIntelligenceOperation",
);
