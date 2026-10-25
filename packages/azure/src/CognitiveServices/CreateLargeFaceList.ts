import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface CreateLargeFaceListRequest extends Omit<
  face.FaceListOperationsCreateLargeFaceListRequest,
  "endpoint"
> {}

/**
 * Create an empty Large Face List with user-specified largeFaceListId, name,
 * an optional userData and recognitionModel. Large Face List is a list of
 * faces, up to 1,000,000 faces, and used by "Find Similar From Large Face
 * List".
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
 * {@link CreateLargeFaceListHttp}.
 *
 * ### Calling CreateLargeFaceList
 * **Example:** CreateLargeFaceList from a Function
 * ```typescript
 * // init
 * const createLargeFaceList = yield* Azure.CognitiveServices.CreateLargeFaceList(account);
 *
 * // runtime
 * const result = yield* createLargeFaceList({ largeFaceListId, name });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface CreateLargeFaceList extends Binding.Service<
  CreateLargeFaceList,
  "Azure.CognitiveServices.CreateLargeFaceList",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: CreateLargeFaceListRequest,
    ) => Effect.Effect<
      face.FaceListOperationsCreateLargeFaceListResponse,
      face.FaceListOperationsCreateLargeFaceListError,
      RuntimeContext
    >
  >
> {}

export const CreateLargeFaceList = Binding.Service<CreateLargeFaceList>(
  "Azure.CognitiveServices.CreateLargeFaceList",
);
