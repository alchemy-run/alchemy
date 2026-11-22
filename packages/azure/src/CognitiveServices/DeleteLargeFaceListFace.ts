import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface DeleteLargeFaceListFaceRequest extends Omit<
  face.FaceListOperationsDeleteLargeFaceListFaceRequest,
  "endpoint"
> {}

/**
 * Delete a face from a Large Face List by specified largeFaceListId and
 * persistedFaceId.
 *
 * Binding assigns a custom role (`AzureAILargeFaceListFacesDeleteRole`, one
 * per stack) with exactly the data action
 * `Face/largefacelists/persistedfaces/delete` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link DeleteLargeFaceListFaceHttp}.
 *
 * ### Calling DeleteLargeFaceListFace
 * **Example:** DeleteLargeFaceListFace from a Function
 * ```typescript
 * // init
 * const deleteLargeFaceListFace = yield* Azure.CognitiveServices.DeleteLargeFaceListFace(account);
 *
 * // runtime
 * const result = yield* deleteLargeFaceListFace({ largeFaceListId, persistedFaceId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface DeleteLargeFaceListFace extends Binding.Service<
  DeleteLargeFaceListFace,
  "Azure.CognitiveServices.DeleteLargeFaceListFace",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: DeleteLargeFaceListFaceRequest,
    ) => Effect.Effect<
      face.FaceListOperationsDeleteLargeFaceListFaceResponse,
      face.FaceListOperationsDeleteLargeFaceListFaceError,
      RuntimeContext
    >
  >
> {}

export const DeleteLargeFaceListFace = Binding.Service<DeleteLargeFaceListFace>(
  "Azure.CognitiveServices.DeleteLargeFaceListFace",
);
