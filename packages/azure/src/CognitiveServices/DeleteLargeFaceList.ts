import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface DeleteLargeFaceListRequest extends Omit<
  face.FaceListOperationsDeleteLargeFaceListRequest,
  "endpoint"
> {}

/**
 * Delete a face from a Large Face List by specified largeFaceListId and
 * persistedFaceId. Adding/deleting faces to/from a same Large Face List are
 * processed sequentially and to/from different Large Face Lists are in
 * parallel.
 *
 * Binding assigns a custom role (`AzureAILargeFaceListsDeleteRole`, one per
 * stack) with exactly the data action `Face/largefacelists/delete` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link DeleteLargeFaceListHttp}.
 *
 * ### Calling DeleteLargeFaceList
 * **Example:** DeleteLargeFaceList from a Function
 * ```typescript
 * // init
 * const deleteLargeFaceList = yield* Azure.CognitiveServices.DeleteLargeFaceList(account);
 *
 * // runtime
 * const result = yield* deleteLargeFaceList({ largeFaceListId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface DeleteLargeFaceList extends Binding.Service<
  DeleteLargeFaceList,
  "Azure.CognitiveServices.DeleteLargeFaceList",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: DeleteLargeFaceListRequest,
    ) => Effect.Effect<
      face.FaceListOperationsDeleteLargeFaceListResponse,
      face.FaceListOperationsDeleteLargeFaceListError,
      RuntimeContext
    >
  >
> {}

export const DeleteLargeFaceList = Binding.Service<DeleteLargeFaceList>(
  "Azure.CognitiveServices.DeleteLargeFaceList",
);
