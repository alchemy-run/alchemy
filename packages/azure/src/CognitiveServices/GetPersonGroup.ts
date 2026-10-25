import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface GetPersonGroupRequest extends Omit<
  face.GetPersonGroupOperationPersonGroupRequest,
  "endpoint"
> {}

/**
 * Retrieve Person Group name, userData and recognitionModel. To get person
 * information under this personGroup, use "Get Person Group Persons".
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
 * {@link GetPersonGroupHttp}.
 *
 * ### Calling GetPersonGroup
 * **Example:** GetPersonGroup from a Function
 * ```typescript
 * // init
 * const getPersonGroup = yield* Azure.CognitiveServices.GetPersonGroup(account);
 *
 * // runtime
 * const result = yield* getPersonGroup({ personGroupId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface GetPersonGroup extends Binding.Service<
  GetPersonGroup,
  "Azure.CognitiveServices.GetPersonGroup",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: GetPersonGroupRequest,
    ) => Effect.Effect<
      face.PersonGroup,
      face.GetPersonGroupOperationPersonGroupError,
      RuntimeContext
    >
  >
> {}

export const GetPersonGroup = Binding.Service<GetPersonGroup>(
  "Azure.CognitiveServices.GetPersonGroup",
);
