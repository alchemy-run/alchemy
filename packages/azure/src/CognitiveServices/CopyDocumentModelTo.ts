import type * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface CopyDocumentModelToRequest extends Omit<
  documents.CopyDocumentModelModelToRequest,
  "endpoint"
> {}

/**
 * Copies document model to the target resource, region, and modelId.
 *
 * Binding assigns a custom role (`AzureAIDocumentModelsCopyToRole`, one per
 * stack) with exactly the data action
 * `FormRecognizer/documentmodels:copyto/action` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link CopyDocumentModelToHttp}.
 *
 * ### Calling CopyDocumentModelTo
 * **Example:** CopyDocumentModelTo from a Function
 * ```typescript
 * // init
 * const copyDocumentModelTo = yield* Azure.CognitiveServices.CopyDocumentModelTo(account);
 *
 * // runtime
 * const result = yield* copyDocumentModelTo({ modelId, targetResourceId, targetResourceRegion, targetModelId, targetModelLocation, accessToken, expirationDateTime });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface CopyDocumentModelTo extends Binding.Service<
  CopyDocumentModelTo,
  "Azure.CognitiveServices.CopyDocumentModelTo",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: CopyDocumentModelToRequest,
    ) => Effect.Effect<
      documents.CopyDocumentModelModelToResponse,
      documents.CopyDocumentModelModelToError,
      RuntimeContext
    >
  >
> {}

export const CopyDocumentModelTo = Binding.Service<CopyDocumentModelTo>(
  "Azure.CognitiveServices.CopyDocumentModelTo",
);
