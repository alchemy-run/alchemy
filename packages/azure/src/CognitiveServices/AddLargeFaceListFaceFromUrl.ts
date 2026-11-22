import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface AddLargeFaceListFaceFromUrlRequest extends Omit<
  face.FaceListOperationsAddLargeFaceListFaceFromUrlRequest,
  "endpoint"
> {}

/**
 * Add a face to a specified Large Face List, up to 1,000,000 faces. To deal
 * with an image containing multiple faces, input face can be specified as an
 * image with a targetFace rectangle. It returns a persistedFaceId
 * representing the added face. No image will be stored.
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
 * {@link AddLargeFaceListFaceFromUrlHttp}.
 *
 * ### Calling AddLargeFaceListFaceFromUrl
 * **Example:** AddLargeFaceListFaceFromUrl from a Function
 * ```typescript
 * // init
 * const addLargeFaceListFaceFromUrl = yield* Azure.CognitiveServices.AddLargeFaceListFaceFromUrl(account);
 *
 * // runtime
 * const result = yield* addLargeFaceListFaceFromUrl({ largeFaceListId, url });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface AddLargeFaceListFaceFromUrl extends Binding.Service<
  AddLargeFaceListFaceFromUrl,
  "Azure.CognitiveServices.AddLargeFaceListFaceFromUrl",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: AddLargeFaceListFaceFromUrlRequest,
    ) => Effect.Effect<
      face.AddFaceResult,
      face.FaceListOperationsAddLargeFaceListFaceFromUrlError,
      RuntimeContext
    >
  >
> {}

export const AddLargeFaceListFaceFromUrl = Binding.Service<AddLargeFaceListFaceFromUrl>(
  "Azure.CognitiveServices.AddLargeFaceListFaceFromUrl",
);
