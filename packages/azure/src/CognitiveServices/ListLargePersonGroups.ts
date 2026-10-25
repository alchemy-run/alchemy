import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface ListLargePersonGroupsRequest extends Omit<
  face.GetPersonGroupOperationLargePersonGroupsRequest,
  "endpoint"
> {}

/**
 * List all existing Large Person Groups' largePersonGroupId, name, userData
 * and recognitionModel. Large Person Groups are stored in alphabetical order
 * of largePersonGroupId. * "start" parameter (string, optional) specifies an
 * ID value from which returned entries will have larger IDs based on string
 * comparison.
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
 * {@link ListLargePersonGroupsHttp}.
 *
 * ### Calling ListLargePersonGroups
 * **Example:** ListLargePersonGroups from a Function
 * ```typescript
 * // init
 * const listLargePersonGroups = yield* Azure.CognitiveServices.ListLargePersonGroups(account);
 *
 * // runtime
 * const result = yield* listLargePersonGroups();
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface ListLargePersonGroups extends Binding.Service<
  ListLargePersonGroups,
  "Azure.CognitiveServices.ListLargePersonGroups",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request?: ListLargePersonGroupsRequest,
    ) => Effect.Effect<
      face.GetPersonGroupOperationLargePersonGroupsResponse,
      face.GetPersonGroupOperationLargePersonGroupsError,
      RuntimeContext
    >
  >
> {}

export const ListLargePersonGroups = Binding.Service<ListLargePersonGroups>(
  "Azure.CognitiveServices.ListLargePersonGroups",
);
