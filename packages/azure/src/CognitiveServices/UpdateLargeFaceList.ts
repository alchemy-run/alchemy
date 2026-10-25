import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface UpdateLargeFaceListRequest extends Omit<
  face.FaceListOperationsUpdateLargeFaceListRequest,
  "endpoint"
> {}

/**
 * Update information of a Large Face List, including name and userData.
 *
 * Binding assigns a custom role (`AzureAILargeFaceListsWriteRole`, one per
 * stack) with exactly the data action `Face/largefacelists/write` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link UpdateLargeFaceListHttp}.
 *
 * ### Calling UpdateLargeFaceList
 * **Example:** UpdateLargeFaceList from a Function
 * ```typescript
 * // init
 * const updateLargeFaceList = yield* Azure.CognitiveServices.UpdateLargeFaceList(account);
 *
 * // runtime
 * const result = yield* updateLargeFaceList({ largeFaceListId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface UpdateLargeFaceList extends Binding.Service<
  UpdateLargeFaceList,
  "Azure.CognitiveServices.UpdateLargeFaceList",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: UpdateLargeFaceListRequest,
    ) => Effect.Effect<
      face.FaceListOperationsUpdateLargeFaceListResponse,
      face.FaceListOperationsUpdateLargeFaceListError,
      RuntimeContext
    >
  >
> {}

export const UpdateLargeFaceList = Binding.Service<UpdateLargeFaceList>(
  "Azure.CognitiveServices.UpdateLargeFaceList",
);
