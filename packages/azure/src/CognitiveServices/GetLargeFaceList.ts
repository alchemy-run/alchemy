import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface GetLargeFaceListRequest extends Omit<
  face.FaceListOperationsGetLargeFaceListRequest,
  "endpoint"
> {}

/**
 * Retrieve a Large Face List's largeFaceListId, name, userData and
 * recognitionModel.
 *
 * Binding assigns a custom role (`AzureAILargeFaceListsReadRole`, one per
 * stack) with exactly the data action `Face/largefacelists/read` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link GetLargeFaceListHttp}.
 *
 * ### Calling GetLargeFaceList
 * **Example:** GetLargeFaceList from a Function
 * ```typescript
 * // init
 * const getLargeFaceList = yield* Azure.CognitiveServices.GetLargeFaceList(account);
 *
 * // runtime
 * const result = yield* getLargeFaceList({ largeFaceListId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface GetLargeFaceList extends Binding.Service<
  GetLargeFaceList,
  "Azure.CognitiveServices.GetLargeFaceList",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: GetLargeFaceListRequest,
    ) => Effect.Effect<
      face.LargeFaceList,
      face.FaceListOperationsGetLargeFaceListError,
      RuntimeContext
    >
  >
> {}

export const GetLargeFaceList = Binding.Service<GetLargeFaceList>(
  "Azure.CognitiveServices.GetLargeFaceList",
);
