import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface DeleteLargePersonGroupRequest extends Omit<
  face.DeletePersonGroupOperationLargePersonGroupRequest,
  "endpoint"
> {}

/**
 * Delete an existing Large Person Group with specified personGroupId.
 * Persisted data in this Large Person Group will be deleted.
 *
 * Binding assigns a custom role (`AzureAILargePersonGroupsDeleteRole`, one
 * per stack) with exactly the data action `Face/largepersongroups/delete`
 * (under `Microsoft.CognitiveServices/accounts/`), on the account only. The
 * account needs a custom subdomain (Alchemy sets one by default). The
 * built-in **Azure AI User** and **Cognitive Services User** roles grant
 * every `Microsoft.CognitiveServices/*` data action. On a host with a
 * managed identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link DeleteLargePersonGroupHttp}.
 *
 * ### Calling DeleteLargePersonGroup
 * **Example:** DeleteLargePersonGroup from a Function
 * ```typescript
 * // init
 * const deleteLargePersonGroup = yield* Azure.CognitiveServices.DeleteLargePersonGroup(account);
 *
 * // runtime
 * const result = yield* deleteLargePersonGroup({ largePersonGroupId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface DeleteLargePersonGroup extends Binding.Service<
  DeleteLargePersonGroup,
  "Azure.CognitiveServices.DeleteLargePersonGroup",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: DeleteLargePersonGroupRequest,
    ) => Effect.Effect<
      face.DeletePersonGroupOperationLargePersonGroupResponse,
      face.DeletePersonGroupOperationLargePersonGroupError,
      RuntimeContext
    >
  >
> {}

export const DeleteLargePersonGroup = Binding.Service<DeleteLargePersonGroup>(
  "Azure.CognitiveServices.DeleteLargePersonGroup",
);
