import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface AddFaceListFaceRequest extends Omit<
  face.FaceListOperationsAddFaceListFaceRequest,
  "endpoint"
> {}

/**
 * Add a face to a specified Face List, up to 1,000 faces. To deal with an
 * image containing multiple faces, input face can be specified as an image
 * with a targetFace rectangle. It returns a persistedFaceId representing the
 * added face. No image will be stored.
 *
 * Binding assigns a custom role (`AzureAIFaceListFacesWriteRole`, one per
 * stack) with exactly the data action `Face/facelists/persistedfaces/write`
 * (under `Microsoft.CognitiveServices/accounts/`), on the account only. The
 * account needs a custom subdomain (Alchemy sets one by default). The
 * built-in **Azure AI User** and **Cognitive Services User** roles grant
 * every `Microsoft.CognitiveServices/*` data action. On a host with a
 * managed identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link AddFaceListFaceHttp}.
 *
 * ### Calling AddFaceListFace
 * **Example:** AddFaceListFace from a Function
 * ```typescript
 * // init
 * const addFaceListFace = yield* Azure.CognitiveServices.AddFaceListFace(account);
 *
 * // runtime
 * const result = yield* addFaceListFace({ faceListId, body });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface AddFaceListFace extends Binding.Service<
  AddFaceListFace,
  "Azure.CognitiveServices.AddFaceListFace",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: AddFaceListFaceRequest,
    ) => Effect.Effect<
      face.AddFaceResult,
      face.FaceListOperationsAddFaceListFaceError,
      RuntimeContext
    >
  >
> {}

export const AddFaceListFace = Binding.Service<AddFaceListFace>(
  "Azure.CognitiveServices.AddFaceListFace",
);
