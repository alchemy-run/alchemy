import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface ListFaceListsRequest extends Omit<
  face.GetFaceListOperationFaceListsRequest,
  "endpoint"
> {}

/**
 * List Face Lists' faceListId, name, userData and recognitionModel. To get
 * face information inside Face List use "Get Face List".
 *
 * Binding assigns a custom role (`AzureAIFaceListsReadRole`, one per stack)
 * with exactly the data action `Face/facelists/read` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link ListFaceListsHttp}.
 *
 * ### Calling ListFaceLists
 * **Example:** ListFaceLists from a Function
 * ```typescript
 * // init
 * const listFaceLists = yield* Azure.CognitiveServices.ListFaceLists(account);
 *
 * // runtime
 * const result = yield* listFaceLists();
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface ListFaceLists extends Binding.Service<
  ListFaceLists,
  "Azure.CognitiveServices.ListFaceLists",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request?: ListFaceListsRequest,
    ) => Effect.Effect<
      face.GetFaceListOperationFaceListsResponse,
      face.GetFaceListOperationFaceListsError,
      RuntimeContext
    >
  >
> {}

export const ListFaceLists = Binding.Service<ListFaceLists>(
  "Azure.CognitiveServices.ListFaceLists",
);
