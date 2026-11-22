import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface DeleteLargePersonGroupPersonFaceRequest extends Omit<
  face.DeletePersonGroupOperationLargePersonGroupPersonFaceRequest,
  "endpoint"
> {}

/**
 * Delete a face from a person in a Large Person Group by specified
 * largePersonGroupId, personId and persistedFaceId. Adding/deleting faces
 * to/from a same person will be processed sequentially. Adding/deleting
 * faces to/from different persons are processed in parallel.
 *
 * Binding assigns a custom role (`AzureAILargePersonGroupFacesDeleteRole`,
 * one per stack) with exactly the data action
 * `Face/largepersongroups/persons/persistedfaces/delete` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link DeleteLargePersonGroupPersonFaceHttp}.
 *
 * ### Calling DeleteLargePersonGroupPersonFace
 * **Example:** DeleteLargePersonGroupPersonFace from a Function
 * ```typescript
 * // init
 * const deleteLargePersonGroupPersonFace = yield* Azure.CognitiveServices.DeleteLargePersonGroupPersonFace(account);
 *
 * // runtime
 * const result = yield* deleteLargePersonGroupPersonFace({ largePersonGroupId, personId, persistedFaceId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface DeleteLargePersonGroupPersonFace extends Binding.Service<
  DeleteLargePersonGroupPersonFace,
  "Azure.CognitiveServices.DeleteLargePersonGroupPersonFace",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: DeleteLargePersonGroupPersonFaceRequest,
    ) => Effect.Effect<
      face.DeletePersonGroupOperationLargePersonGroupPersonFaceResponse,
      face.DeletePersonGroupOperationLargePersonGroupPersonFaceError,
      RuntimeContext
    >
  >
> {}

export const DeleteLargePersonGroupPersonFace = Binding.Service<DeleteLargePersonGroupPersonFace>(
  "Azure.CognitiveServices.DeleteLargePersonGroupPersonFace",
);
