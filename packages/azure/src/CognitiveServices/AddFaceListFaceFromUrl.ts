import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface AddFaceListFaceFromUrlRequest extends Omit<
  face.FaceListOperationsAddFaceListFaceFromUrlRequest,
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
 * {@link AddFaceListFaceFromUrlHttp}.
 *
 * ### Calling AddFaceListFaceFromUrl
 * **Example:** AddFaceListFaceFromUrl from a Function
 * ```typescript
 * // init
 * const addFaceListFaceFromUrl = yield* Azure.CognitiveServices.AddFaceListFaceFromUrl(account);
 *
 * // runtime
 * const result = yield* addFaceListFaceFromUrl({ faceListId, url });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface AddFaceListFaceFromUrl extends Binding.Service<
  AddFaceListFaceFromUrl,
  "Azure.CognitiveServices.AddFaceListFaceFromUrl",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: AddFaceListFaceFromUrlRequest,
    ) => Effect.Effect<
      face.AddFaceResult,
      face.FaceListOperationsAddFaceListFaceFromUrlError,
      RuntimeContext
    >
  >
> {}

export const AddFaceListFaceFromUrl = Binding.Service<AddFaceListFaceFromUrl>(
  "Azure.CognitiveServices.AddFaceListFaceFromUrl",
);
