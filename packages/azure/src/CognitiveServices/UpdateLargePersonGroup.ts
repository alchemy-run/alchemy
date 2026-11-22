import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface UpdateLargePersonGroupRequest extends Omit<
  face.UpdatePersonGroupOperationLargePersonGroupRequest,
  "endpoint"
> {}

/**
 * Update an existing Large Person Group's name and userData. The properties
 * keep unchanged if they are not in request body.
 *
 * Binding assigns a custom role (`AzureAILargePersonGroupsWriteRole`, one
 * per stack) with exactly the data action `Face/largepersongroups/write`
 * (under `Microsoft.CognitiveServices/accounts/`), on the account only. The
 * account needs a custom subdomain (Alchemy sets one by default). The
 * built-in **Azure AI User** and **Cognitive Services User** roles grant
 * every `Microsoft.CognitiveServices/*` data action. On a host with a
 * managed identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link UpdateLargePersonGroupHttp}.
 *
 * ### Calling UpdateLargePersonGroup
 * **Example:** UpdateLargePersonGroup from a Function
 * ```typescript
 * // init
 * const updateLargePersonGroup = yield* Azure.CognitiveServices.UpdateLargePersonGroup(account);
 *
 * // runtime
 * const result = yield* updateLargePersonGroup({ largePersonGroupId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface UpdateLargePersonGroup extends Binding.Service<
  UpdateLargePersonGroup,
  "Azure.CognitiveServices.UpdateLargePersonGroup",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: UpdateLargePersonGroupRequest,
    ) => Effect.Effect<
      face.UpdatePersonGroupOperationLargePersonGroupResponse,
      face.UpdatePersonGroupOperationLargePersonGroupError,
      RuntimeContext
    >
  >
> {}

export const UpdateLargePersonGroup = Binding.Service<UpdateLargePersonGroup>(
  "Azure.CognitiveServices.UpdateLargePersonGroup",
);
