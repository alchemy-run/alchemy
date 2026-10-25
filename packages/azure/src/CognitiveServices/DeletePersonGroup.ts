import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface DeletePersonGroupRequest extends Omit<
  face.DeletePersonGroupOperationPersonGroupRequest,
  "endpoint"
> {}

/**
 * Delete an existing Person Group with specified personGroupId. Persisted
 * data in this Person Group will be deleted.
 *
 * Binding assigns a custom role (`AzureAIPersonGroupsDeleteRole`, one per
 * stack) with exactly the data action `Face/persongroups/delete` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link DeletePersonGroupHttp}.
 *
 * ### Calling DeletePersonGroup
 * **Example:** DeletePersonGroup from a Function
 * ```typescript
 * // init
 * const deletePersonGroup = yield* Azure.CognitiveServices.DeletePersonGroup(account);
 *
 * // runtime
 * const result = yield* deletePersonGroup({ personGroupId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface DeletePersonGroup extends Binding.Service<
  DeletePersonGroup,
  "Azure.CognitiveServices.DeletePersonGroup",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: DeletePersonGroupRequest,
    ) => Effect.Effect<
      face.DeletePersonGroupOperationPersonGroupResponse,
      face.DeletePersonGroupOperationPersonGroupError,
      RuntimeContext
    >
  >
> {}

export const DeletePersonGroup = Binding.Service<DeletePersonGroup>(
  "Azure.CognitiveServices.DeletePersonGroup",
);
