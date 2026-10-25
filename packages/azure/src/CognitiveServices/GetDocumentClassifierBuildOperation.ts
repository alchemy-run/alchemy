import type * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface GetDocumentClassifierBuildOperationRequest extends Omit<
  documents.GetMiscellaneousOperationDocumentClassifierBuildOperationRequest,
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
 * {@link GetDocumentClassifierBuildOperationHttp}.
 *
 * ### Calling GetDocumentClassifierBuildOperation
 * **Example:** GetDocumentClassifierBuildOperation from a Function
 * ```typescript
 * // init
 * const getDocumentClassifierBuildOperation = yield* Azure.CognitiveServices.GetDocumentClassifierBuildOperation(account);
 *
 * // runtime
 * const result = yield* getDocumentClassifierBuildOperation({ operationId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface GetDocumentClassifierBuildOperation extends Binding.Service<
  GetDocumentClassifierBuildOperation,
  "Azure.CognitiveServices.GetDocumentClassifierBuildOperation",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: GetDocumentClassifierBuildOperationRequest,
    ) => Effect.Effect<
      documents.GetMiscellaneousOperationDocumentClassifierBuildOperationResponse,
      documents.GetMiscellaneousOperationDocumentClassifierBuildOperationError,
      RuntimeContext
    >
  >
> {}

export const GetDocumentClassifierBuildOperation =
  Binding.Service<GetDocumentClassifierBuildOperation>(
    "Azure.CognitiveServices.GetDocumentClassifierBuildOperation",
  );
