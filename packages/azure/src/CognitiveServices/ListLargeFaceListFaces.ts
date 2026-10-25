import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface ListLargeFaceListFacesRequest extends Omit<
  face.FaceListOperationsGetLargeFaceListFacesRequest,
  "endpoint"
> {}

/**
 * List faces' persistedFaceId and userData in a specified Large Face List.
 * Faces are stored in alphabetical order of persistedFaceId created in "Add
 * Large Face List Face". * "start" parameter (string, optional) specifies an
 * ID value from which returned entries will have larger IDs based on string
 * comparison.
 *
 * Binding assigns a custom role (`AzureAILargeFaceListFacesReadRole`, one
 * per stack) with exactly the data action
 * `Face/largefacelists/persistedfaces/read` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link ListLargeFaceListFacesHttp}.
 *
 * ### Calling ListLargeFaceListFaces
 * **Example:** ListLargeFaceListFaces from a Function
 * ```typescript
 * // init
 * const listLargeFaceListFaces = yield* Azure.CognitiveServices.ListLargeFaceListFaces(account);
 *
 * // runtime
 * const result = yield* listLargeFaceListFaces({ largeFaceListId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface ListLargeFaceListFaces extends Binding.Service<
  ListLargeFaceListFaces,
  "Azure.CognitiveServices.ListLargeFaceListFaces",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: ListLargeFaceListFacesRequest,
    ) => Effect.Effect<
      face.FaceListOperationsGetLargeFaceListFacesResponse,
      face.FaceListOperationsGetLargeFaceListFacesError,
      RuntimeContext
    >
  >
> {}

export const ListLargeFaceListFaces = Binding.Service<ListLargeFaceListFaces>(
  "Azure.CognitiveServices.ListLargeFaceListFaces",
);
