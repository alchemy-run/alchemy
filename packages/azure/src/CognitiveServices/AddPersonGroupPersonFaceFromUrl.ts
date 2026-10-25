import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface AddPersonGroupPersonFaceFromUrlRequest extends Omit<
  face.AddPersonGroupOperationPersonGroupPersonFaceFromUrlRequest,
  "endpoint"
> {}

/**
 * Add a face to a person into a Person Group for face identification or
 * verification. To deal with an image containing multiple faces, input face
 * can be specified as an image with a targetFace rectangle. It returns a
 * persistedFaceId representing the added face. No image will be stored.
 *
 * Binding assigns a custom role (`AzureAIPersonGroupFacesWriteRole`, one per
 * stack) with exactly the data action
 * `Face/persongroups/persons/persistedfaces/write` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link AddPersonGroupPersonFaceFromUrlHttp}.
 *
 * ### Calling AddPersonGroupPersonFaceFromUrl
 * **Example:** AddPersonGroupPersonFaceFromUrl from a Function
 * ```typescript
 * // init
 * const addPersonGroupPersonFaceFromUrl = yield* Azure.CognitiveServices.AddPersonGroupPersonFaceFromUrl(account);
 *
 * // runtime
 * const result = yield* addPersonGroupPersonFaceFromUrl({ personGroupId, personId, url });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface AddPersonGroupPersonFaceFromUrl extends Binding.Service<
  AddPersonGroupPersonFaceFromUrl,
  "Azure.CognitiveServices.AddPersonGroupPersonFaceFromUrl",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: AddPersonGroupPersonFaceFromUrlRequest,
    ) => Effect.Effect<
      face.AddFaceResult,
      face.AddPersonGroupOperationPersonGroupPersonFaceFromUrlError,
      RuntimeContext
    >
  >
> {}

export const AddPersonGroupPersonFaceFromUrl = Binding.Service<AddPersonGroupPersonFaceFromUrl>(
  "Azure.CognitiveServices.AddPersonGroupPersonFaceFromUrl",
);
