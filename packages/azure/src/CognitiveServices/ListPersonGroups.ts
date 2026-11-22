import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface ListPersonGroupsRequest extends Omit<
  face.GetPersonGroupOperationPersonGroupsRequest,
  "endpoint"
> {}

/**
 * List Person Groups' personGroupId, name, userData and recognitionModel.
 * Person Groups are stored in alphabetical order of personGroupId. * "start"
 * parameter (string, optional) specifies an ID value from which returned
 * entries will have larger IDs based on string comparison.
 *
 * Binding assigns a custom role (`AzureAIPersonGroupsReadRole`, one per
 * stack) with exactly the data action `Face/persongroups/read` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link ListPersonGroupsHttp}.
 *
 * ### Calling ListPersonGroups
 * **Example:** ListPersonGroups from a Function
 * ```typescript
 * // init
 * const listPersonGroups = yield* Azure.CognitiveServices.ListPersonGroups(account);
 *
 * // runtime
 * const result = yield* listPersonGroups();
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface ListPersonGroups extends Binding.Service<
  ListPersonGroups,
  "Azure.CognitiveServices.ListPersonGroups",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request?: ListPersonGroupsRequest,
    ) => Effect.Effect<
      face.GetPersonGroupOperationPersonGroupsResponse,
      face.GetPersonGroupOperationPersonGroupsError,
      RuntimeContext
    >
  >
> {}

export const ListPersonGroups = Binding.Service<ListPersonGroups>(
  "Azure.CognitiveServices.ListPersonGroups",
);
