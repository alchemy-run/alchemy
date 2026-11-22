import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface UpdatePersonGroupRequest extends Omit<
  face.UpdatePersonGroupOperationPersonGroupRequest,
  "endpoint"
> {}

/**
 * Update an existing Person Group's name and userData. The properties keep
 * unchanged if they are not in request body.
 *
 * Binding assigns a custom role (`AzureAIPersonGroupsWriteRole`, one per
 * stack) with exactly the data action `Face/persongroups/write` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link UpdatePersonGroupHttp}.
 *
 * ### Calling UpdatePersonGroup
 * **Example:** UpdatePersonGroup from a Function
 * ```typescript
 * // init
 * const updatePersonGroup = yield* Azure.CognitiveServices.UpdatePersonGroup(account);
 *
 * // runtime
 * const result = yield* updatePersonGroup({ personGroupId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface UpdatePersonGroup extends Binding.Service<
  UpdatePersonGroup,
  "Azure.CognitiveServices.UpdatePersonGroup",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: UpdatePersonGroupRequest,
    ) => Effect.Effect<
      face.UpdatePersonGroupOperationPersonGroupResponse,
      face.UpdatePersonGroupOperationPersonGroupError,
      RuntimeContext
    >
  >
> {}

export const UpdatePersonGroup = Binding.Service<UpdatePersonGroup>(
  "Azure.CognitiveServices.UpdatePersonGroup",
);
