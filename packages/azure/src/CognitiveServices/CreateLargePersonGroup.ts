import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface CreateLargePersonGroupRequest extends Omit<
  face.CreatePersonGroupOperationLargePersonGroupRequest,
  "endpoint"
> {}

/**
 * Create a new Large Person Group with user-specified largePersonGroupId,
 * name, an optional userData and recognitionModel. A Large Person Group is a
 * container holding the uploaded person data, including the face recognition
 * features. It can hold up to 1,000,000 entities.
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
 * {@link CreateLargePersonGroupHttp}.
 *
 * ### Calling CreateLargePersonGroup
 * **Example:** CreateLargePersonGroup from a Function
 * ```typescript
 * // init
 * const createLargePersonGroup = yield* Azure.CognitiveServices.CreateLargePersonGroup(account);
 *
 * // runtime
 * const result = yield* createLargePersonGroup({ largePersonGroupId, name });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface CreateLargePersonGroup extends Binding.Service<
  CreateLargePersonGroup,
  "Azure.CognitiveServices.CreateLargePersonGroup",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: CreateLargePersonGroupRequest,
    ) => Effect.Effect<
      face.CreatePersonGroupOperationLargePersonGroupResponse,
      face.CreatePersonGroupOperationLargePersonGroupError,
      RuntimeContext
    >
  >
> {}

export const CreateLargePersonGroup = Binding.Service<CreateLargePersonGroup>(
  "Azure.CognitiveServices.CreateLargePersonGroup",
);
