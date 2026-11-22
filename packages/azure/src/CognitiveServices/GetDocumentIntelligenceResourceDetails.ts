import type * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface GetDocumentIntelligenceResourceDetailsRequest extends Omit<
  documents.GetMiscellaneousOperationResourceDetailsRequest,
  "endpoint"
> {}

/**
 * Return information about the current resource.
 *
 * Binding assigns a custom role (`AzureAIDocumentInfoReadRole`, one per
 * stack) with exactly the data action `FormRecognizer/info/read` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link GetDocumentIntelligenceResourceDetailsHttp}.
 *
 * ### Calling GetDocumentIntelligenceResourceDetails
 * **Example:** GetDocumentIntelligenceResourceDetails from a Function
 * ```typescript
 * // init
 * const getDocumentIntelligenceResourceDetails = yield* Azure.CognitiveServices.GetDocumentIntelligenceResourceDetails(account);
 *
 * // runtime
 * const result = yield* getDocumentIntelligenceResourceDetails();
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface GetDocumentIntelligenceResourceDetails extends Binding.Service<
  GetDocumentIntelligenceResourceDetails,
  "Azure.CognitiveServices.GetDocumentIntelligenceResourceDetails",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request?: GetDocumentIntelligenceResourceDetailsRequest,
    ) => Effect.Effect<
      documents.DocumentIntelligenceResourceDetails,
      documents.GetMiscellaneousOperationResourceDetailsError,
      RuntimeContext
    >
  >
> {}

export const GetDocumentIntelligenceResourceDetails =
  Binding.Service<GetDocumentIntelligenceResourceDetails>(
    "Azure.CognitiveServices.GetDocumentIntelligenceResourceDetails",
  );
