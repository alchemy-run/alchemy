import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface UpdateLargeFaceListFaceRequest extends Omit<
  face.FaceListOperationsUpdateLargeFaceListFaceRequest,
  "endpoint"
> {}

/**
 * Update a specified face's userData field in a Large Face List by its
 * persistedFaceId.
 *
 * Binding assigns a custom role (`AzureAILargeFaceListFacesWriteRole`, one
 * per stack) with exactly the data action
 * `Face/largefacelists/persistedfaces/write` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link UpdateLargeFaceListFaceHttp}.
 *
 * ### Calling UpdateLargeFaceListFace
 * **Example:** UpdateLargeFaceListFace from a Function
 * ```typescript
 * // init
 * const updateLargeFaceListFace = yield* Azure.CognitiveServices.UpdateLargeFaceListFace(account);
 *
 * // runtime
 * const result = yield* updateLargeFaceListFace({ largeFaceListId, persistedFaceId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface UpdateLargeFaceListFace extends Binding.Service<
  UpdateLargeFaceListFace,
  "Azure.CognitiveServices.UpdateLargeFaceListFace",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: UpdateLargeFaceListFaceRequest,
    ) => Effect.Effect<
      face.FaceListOperationsUpdateLargeFaceListFaceResponse,
      face.FaceListOperationsUpdateLargeFaceListFaceError,
      RuntimeContext
    >
  >
> {}

export const UpdateLargeFaceListFace = Binding.Service<UpdateLargeFaceListFace>(
  "Azure.CognitiveServices.UpdateLargeFaceListFace",
);
