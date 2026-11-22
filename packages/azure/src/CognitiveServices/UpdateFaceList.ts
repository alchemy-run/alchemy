import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface UpdateFaceListRequest extends Omit<
  face.FaceListOperationsUpdateFaceListRequest,
  "endpoint"
> {}

/**
 * Update information of a Face List, including name and userData.
 *
 * Binding assigns a custom role (`AzureAIFaceListsWriteRole`, one per stack)
 * with exactly the data action `Face/facelists/write` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link UpdateFaceListHttp}.
 *
 * ### Calling UpdateFaceList
 * **Example:** UpdateFaceList from a Function
 * ```typescript
 * // init
 * const updateFaceList = yield* Azure.CognitiveServices.UpdateFaceList(account);
 *
 * // runtime
 * const result = yield* updateFaceList({ faceListId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface UpdateFaceList extends Binding.Service<
  UpdateFaceList,
  "Azure.CognitiveServices.UpdateFaceList",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: UpdateFaceListRequest,
    ) => Effect.Effect<
      face.FaceListOperationsUpdateFaceListResponse,
      face.FaceListOperationsUpdateFaceListError,
      RuntimeContext
    >
  >
> {}

export const UpdateFaceList = Binding.Service<UpdateFaceList>(
  "Azure.CognitiveServices.UpdateFaceList",
);
