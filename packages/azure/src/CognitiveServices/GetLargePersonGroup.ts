import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface GetLargePersonGroupRequest extends Omit<
  face.GetPersonGroupOperationLargePersonGroupRequest,
  "endpoint"
> {}

/**
 * Retrieve the information of a Large Person Group, including its name,
 * userData and recognitionModel. This API returns Large Person Group
 * information only, use "Get Large Person Group Persons" instead to retrieve
 * person information under the Large Person Group.
 *
 * Binding assigns a custom role (`AzureAILargePersonGroupsReadRole`, one per
 * stack) with exactly the data action `Face/largepersongroups/read` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link GetLargePersonGroupHttp}.
 *
 * ### Calling GetLargePersonGroup
 * **Example:** GetLargePersonGroup from a Function
 * ```typescript
 * // init
 * const getLargePersonGroup = yield* Azure.CognitiveServices.GetLargePersonGroup(account);
 *
 * // runtime
 * const result = yield* getLargePersonGroup({ largePersonGroupId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface GetLargePersonGroup extends Binding.Service<
  GetLargePersonGroup,
  "Azure.CognitiveServices.GetLargePersonGroup",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: GetLargePersonGroupRequest,
    ) => Effect.Effect<
      face.LargePersonGroup,
      face.GetPersonGroupOperationLargePersonGroupError,
      RuntimeContext
    >
  >
> {}

export const GetLargePersonGroup = Binding.Service<GetLargePersonGroup>(
  "Azure.CognitiveServices.GetLargePersonGroup",
);
