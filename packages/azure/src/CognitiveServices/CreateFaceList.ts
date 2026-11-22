import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface CreateFaceListRequest extends Omit<
  face.FaceListOperationsCreateFaceListRequest,
  "endpoint"
> {}

/**
 * Create an empty Face List with user-specified faceListId, name, an
 * optional userData and recognitionModel. Up to 64 Face Lists are allowed in
 * one subscription. Face List is a list of faces, up to 1,000 faces, and
 * used by "Find Similar From Face List".
 *
 * Binding assigns a custom role (`AzureAIFaceListsWriteRole`, one per stack)
 * with exactly the data action `Face/facelists/write` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link CreateFaceListHttp}.
 *
 * ### Calling CreateFaceList
 * **Example:** CreateFaceList from a Function
 * ```typescript
 * // init
 * const createFaceList = yield* Azure.CognitiveServices.CreateFaceList(account);
 *
 * // runtime
 * const result = yield* createFaceList({ faceListId, name });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface CreateFaceList extends Binding.Service<
  CreateFaceList,
  "Azure.CognitiveServices.CreateFaceList",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: CreateFaceListRequest,
    ) => Effect.Effect<
      face.FaceListOperationsCreateFaceListResponse,
      face.FaceListOperationsCreateFaceListError,
      RuntimeContext
    >
  >
> {}

export const CreateFaceList = Binding.Service<CreateFaceList>(
  "Azure.CognitiveServices.CreateFaceList",
);
