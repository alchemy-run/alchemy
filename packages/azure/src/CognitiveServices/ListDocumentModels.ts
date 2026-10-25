import type * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface ListDocumentModelsRequest extends Omit<
  documents.ListDocumentModelModelsRequest,
  "endpoint"
> {}

/**
 * List all document models.
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
 * {@link ListDocumentModelsHttp}.
 *
 * ### Calling ListDocumentModels
 * **Example:** ListDocumentModels from a Function
 * ```typescript
 * // init
 * const listDocumentModels = yield* Azure.CognitiveServices.ListDocumentModels(account);
 *
 * // runtime
 * const { value } = yield* listDocumentModels();
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface ListDocumentModels extends Binding.Service<
  ListDocumentModels,
  "Azure.CognitiveServices.ListDocumentModels",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request?: ListDocumentModelsRequest,
    ) => Effect.Effect<
      documents.PagedDocumentModelDetails,
      documents.ListDocumentModelModelsError,
      RuntimeContext
    >
  >
> {}

export const ListDocumentModels = Binding.Service<ListDocumentModels>(
  "Azure.CognitiveServices.ListDocumentModels",
);
