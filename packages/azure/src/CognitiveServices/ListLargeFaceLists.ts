import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface ListLargeFaceListsRequest extends Omit<
  face.GetFaceListOperationLargeFaceListsRequest,
  "endpoint"
> {}

/**
 * List Large Face Lists' information of largeFaceListId, name, userData and
 * recognitionModel. To get face information inside largeFaceList use "Get
 * Large Face List Face". Large Face Lists are stored in alphabetical order
 * of largeFaceListId.
 *
 * Binding assigns a custom role (`AzureAILargeFaceListsReadRole`, one per
 * stack) with exactly the data action `Face/largefacelists/read` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link ListLargeFaceListsHttp}.
 *
 * ### Calling ListLargeFaceLists
 * **Example:** ListLargeFaceLists from a Function
 * ```typescript
 * // init
 * const listLargeFaceLists = yield* Azure.CognitiveServices.ListLargeFaceLists(account);
 *
 * // runtime
 * const result = yield* listLargeFaceLists();
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface ListLargeFaceLists extends Binding.Service<
  ListLargeFaceLists,
  "Azure.CognitiveServices.ListLargeFaceLists",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request?: ListLargeFaceListsRequest,
    ) => Effect.Effect<
      face.GetFaceListOperationLargeFaceListsResponse,
      face.GetFaceListOperationLargeFaceListsError,
      RuntimeContext
    >
  >
> {}

export const ListLargeFaceLists = Binding.Service<ListLargeFaceLists>(
  "Azure.CognitiveServices.ListLargeFaceLists",
);
