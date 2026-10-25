import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface DeleteFaceListFaceRequest extends Omit<
  face.FaceListOperationsDeleteFaceListFaceRequest,
  "endpoint"
> {}

/**
 * Delete a face from a Face List by specified faceListId and
 * persistedFaceId. Adding/deleting faces to/from a same Face List are
 * processed sequentially and to/from different Face Lists are in parallel.
 *
 * Binding assigns a custom role (`AzureAIFaceListFacesDeleteRole`, one per
 * stack) with exactly the data action `Face/facelists/persistedfaces/delete`
 * (under `Microsoft.CognitiveServices/accounts/`), on the account only. The
 * account needs a custom subdomain (Alchemy sets one by default). The
 * built-in **Azure AI User** and **Cognitive Services User** roles grant
 * every `Microsoft.CognitiveServices/*` data action. On a host with a
 * managed identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link DeleteFaceListFaceHttp}.
 *
 * ### Calling DeleteFaceListFace
 * **Example:** DeleteFaceListFace from a Function
 * ```typescript
 * // init
 * const deleteFaceListFace = yield* Azure.CognitiveServices.DeleteFaceListFace(account);
 *
 * // runtime
 * const result = yield* deleteFaceListFace({ faceListId, persistedFaceId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface DeleteFaceListFace extends Binding.Service<
  DeleteFaceListFace,
  "Azure.CognitiveServices.DeleteFaceListFace",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: DeleteFaceListFaceRequest,
    ) => Effect.Effect<
      face.FaceListOperationsDeleteFaceListFaceResponse,
      face.FaceListOperationsDeleteFaceListFaceError,
      RuntimeContext
    >
  >
> {}

export const DeleteFaceListFace = Binding.Service<DeleteFaceListFace>(
  "Azure.CognitiveServices.DeleteFaceListFace",
);
