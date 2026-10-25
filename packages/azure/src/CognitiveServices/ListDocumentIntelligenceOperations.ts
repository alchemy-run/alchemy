import type * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface ListDocumentIntelligenceOperationsRequest extends Omit<
  documents.ListMiscellaneousOperationOperationsRequest,
  "endpoint"
> {}

/**
 * Lists all operations.
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
 * {@link ListDocumentIntelligenceOperationsHttp}.
 *
 * ### Calling ListDocumentIntelligenceOperations
 * **Example:** ListDocumentIntelligenceOperations from a Function
 * ```typescript
 * // init
 * const listDocumentIntelligenceOperations = yield* Azure.CognitiveServices.ListDocumentIntelligenceOperations(account);
 *
 * // runtime
 * const result = yield* listDocumentIntelligenceOperations();
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface ListDocumentIntelligenceOperations extends Binding.Service<
  ListDocumentIntelligenceOperations,
  "Azure.CognitiveServices.ListDocumentIntelligenceOperations",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request?: ListDocumentIntelligenceOperationsRequest,
    ) => Effect.Effect<
      documents.PagedDocumentIntelligenceOperationDetails,
      documents.ListMiscellaneousOperationOperationsError,
      RuntimeContext
    >
  >
> {}

export const ListDocumentIntelligenceOperations =
  Binding.Service<ListDocumentIntelligenceOperations>(
    "Azure.CognitiveServices.ListDocumentIntelligenceOperations",
  );
