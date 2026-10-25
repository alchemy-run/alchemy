import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface DeleteFaceListRequest extends Omit<
  face.FaceListOperationsDeleteFaceListRequest,
  "endpoint"
> {}

/**
 * Delete a specified Face List.
 *
 * Binding assigns a custom role (`AzureAIFaceListsDeleteRole`, one per
 * stack) with exactly the data action `Face/facelists/delete` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link DeleteFaceListHttp}.
 *
 * ### Calling DeleteFaceList
 * **Example:** DeleteFaceList from a Function
 * ```typescript
 * // init
 * const deleteFaceList = yield* Azure.CognitiveServices.DeleteFaceList(account);
 *
 * // runtime
 * const result = yield* deleteFaceList({ faceListId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface DeleteFaceList extends Binding.Service<
  DeleteFaceList,
  "Azure.CognitiveServices.DeleteFaceList",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: DeleteFaceListRequest,
    ) => Effect.Effect<
      face.FaceListOperationsDeleteFaceListResponse,
      face.FaceListOperationsDeleteFaceListError,
      RuntimeContext
    >
  >
> {}

export const DeleteFaceList = Binding.Service<DeleteFaceList>(
  "Azure.CognitiveServices.DeleteFaceList",
);
