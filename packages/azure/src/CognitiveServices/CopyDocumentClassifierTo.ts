import type * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface CopyDocumentClassifierToRequest extends Omit<
  documents.CopyDocumentClassifierClassifierToRequest,
  "endpoint"
> {}

/**
 * Copies document classifier to the target resource, region, and
 * classifierId.
 *
 * Binding assigns a custom role (`AzureAIDocumentClassifiersCopyToRole`, one
 * per stack) with exactly the data action
 * `FormRecognizer/documentclassifiers:copyto/action` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link CopyDocumentClassifierToHttp}.
 *
 * ### Calling CopyDocumentClassifierTo
 * **Example:** CopyDocumentClassifierTo from a Function
 * ```typescript
 * // init
 * const copyDocumentClassifierTo = yield* Azure.CognitiveServices.CopyDocumentClassifierTo(account);
 *
 * // runtime
 * const result = yield* copyDocumentClassifierTo({ classifierId, targetResourceId, targetResourceRegion, targetClassifierId, targetClassifierLocation, accessToken, expirationDateTime });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface CopyDocumentClassifierTo extends Binding.Service<
  CopyDocumentClassifierTo,
  "Azure.CognitiveServices.CopyDocumentClassifierTo",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: CopyDocumentClassifierToRequest,
    ) => Effect.Effect<
      documents.CopyDocumentClassifierClassifierToResponse,
      documents.CopyDocumentClassifierClassifierToError,
      RuntimeContext
    >
  >
> {}

export const CopyDocumentClassifierTo = Binding.Service<CopyDocumentClassifierTo>(
  "Azure.CognitiveServices.CopyDocumentClassifierTo",
);
