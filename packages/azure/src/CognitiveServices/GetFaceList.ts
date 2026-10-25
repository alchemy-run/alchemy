import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface GetFaceListRequest extends Omit<
  face.FaceListOperationsGetFaceListRequest,
  "endpoint"
> {}

/**
 * Retrieve a Face List's faceListId, name, userData, recognitionModel and
 * faces in the Face List.
 *
 * Binding assigns a custom role (`AzureAIFaceListsReadRole`, one per stack)
 * with exactly the data action `Face/facelists/read` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link GetFaceListHttp}.
 *
 * ### Calling GetFaceList
 * **Example:** GetFaceList from a Function
 * ```typescript
 * // init
 * const getFaceList = yield* Azure.CognitiveServices.GetFaceList(account);
 *
 * // runtime
 * const result = yield* getFaceList({ faceListId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface GetFaceList extends Binding.Service<
  GetFaceList,
  "Azure.CognitiveServices.GetFaceList",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: GetFaceListRequest,
    ) => Effect.Effect<face.FaceList, face.FaceListOperationsGetFaceListError, RuntimeContext>
  >
> {}

export const GetFaceList = Binding.Service<GetFaceList>("Azure.CognitiveServices.GetFaceList");
