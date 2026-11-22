import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface AddPersonGroupPersonFaceRequest extends Omit<
  face.AddPersonGroupOperationPersonGroupPersonFaceRequest,
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
 * {@link AddPersonGroupPersonFaceHttp}.
 *
 * ### Calling AddPersonGroupPersonFace
 * **Example:** AddPersonGroupPersonFace from a Function
 * ```typescript
 * // init
 * const addPersonGroupPersonFace = yield* Azure.CognitiveServices.AddPersonGroupPersonFace(account);
 *
 * // runtime
 * const result = yield* addPersonGroupPersonFace({ personGroupId, personId, body });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface AddPersonGroupPersonFace extends Binding.Service<
  AddPersonGroupPersonFace,
  "Azure.CognitiveServices.AddPersonGroupPersonFace",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: AddPersonGroupPersonFaceRequest,
    ) => Effect.Effect<
      face.AddFaceResult,
      face.AddPersonGroupOperationPersonGroupPersonFaceError,
      RuntimeContext
    >
  >
> {}

export const AddPersonGroupPersonFace = Binding.Service<AddPersonGroupPersonFace>(
  "Azure.CognitiveServices.AddPersonGroupPersonFace",
);
