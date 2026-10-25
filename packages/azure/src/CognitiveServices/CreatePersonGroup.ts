import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface CreatePersonGroupRequest extends Omit<
  face.CreatePersonGroupOperationPersonGroupRequest,
  "endpoint"
> {}

/**
 * Create a new Person Group with specified personGroupId, name,
 * user-provided userData and recognitionModel. A Person Group is a container
 * holding the uploaded person data, including face recognition features.
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
 * {@link CreatePersonGroupHttp}.
 *
 * ### Calling CreatePersonGroup
 * **Example:** CreatePersonGroup from a Function
 * ```typescript
 * // init
 * const createPersonGroup = yield* Azure.CognitiveServices.CreatePersonGroup(account);
 *
 * // runtime
 * const result = yield* createPersonGroup({ personGroupId, name });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface CreatePersonGroup extends Binding.Service<
  CreatePersonGroup,
  "Azure.CognitiveServices.CreatePersonGroup",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: CreatePersonGroupRequest,
    ) => Effect.Effect<
      face.CreatePersonGroupOperationPersonGroupResponse,
      face.CreatePersonGroupOperationPersonGroupError,
      RuntimeContext
    >
  >
> {}

export const CreatePersonGroup = Binding.Service<CreatePersonGroup>(
  "Azure.CognitiveServices.CreatePersonGroup",
);
