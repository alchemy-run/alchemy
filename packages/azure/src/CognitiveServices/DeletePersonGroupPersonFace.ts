import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface DeletePersonGroupPersonFaceRequest extends Omit<
  face.DeletePersonGroupOperationPersonGroupPersonFaceRequest,
  "endpoint"
> {}

/**
 * Delete a face from a person in a Person Group by specified personGroupId,
 * personId and persistedFaceId. Adding/deleting faces to/from a same person
 * will be processed sequentially. Adding/deleting faces to/from different
 * persons are processed in parallel.
 *
 * Binding assigns a custom role (`AzureAIPersonGroupFacesDeleteRole`, one
 * per stack) with exactly the data action
 * `Face/persongroups/persons/persistedfaces/delete` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link DeletePersonGroupPersonFaceHttp}.
 *
 * ### Calling DeletePersonGroupPersonFace
 * **Example:** DeletePersonGroupPersonFace from a Function
 * ```typescript
 * // init
 * const deletePersonGroupPersonFace = yield* Azure.CognitiveServices.DeletePersonGroupPersonFace(account);
 *
 * // runtime
 * const result = yield* deletePersonGroupPersonFace({ personGroupId, personId, persistedFaceId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface DeletePersonGroupPersonFace extends Binding.Service<
  DeletePersonGroupPersonFace,
  "Azure.CognitiveServices.DeletePersonGroupPersonFace",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: DeletePersonGroupPersonFaceRequest,
    ) => Effect.Effect<
      face.DeletePersonGroupOperationPersonGroupPersonFaceResponse,
      face.DeletePersonGroupOperationPersonGroupPersonFaceError,
      RuntimeContext
    >
  >
> {}

export const DeletePersonGroupPersonFace = Binding.Service<DeletePersonGroupPersonFace>(
  "Azure.CognitiveServices.DeletePersonGroupPersonFace",
);
