import type * as discovery from "@distilled.cloud/azure/discovery-workspace";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Workspace } from "./Workspace.ts";

/**
 * `DeleteConversation` request without `endpoint`, which the bound Discovery
 * workspace (its `workspaceApiUri`) supplies.
 */
export interface DeleteConversationRequest extends Omit<
  discovery.DeleteConversationRequest,
  "endpoint"
> {}

/**
 * Delete a conversation.
 *
 * Binding assigns a custom role (`AzureDiscoveryConversationDeleteRole`, one
 * per stack) with exactly the data action
 * `Microsoft.Discovery/workspaces/conversations/delete`, on the bound workspace
 * only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link DeleteConversationHttp}.
 *
 * ### Calling DeleteConversation
 * **Example:** DeleteConversation from a Function
 * ```typescript
 * // init
 * const workspace = yield* Azure.Discovery.Workspace("lab", { supercomputerIds: [supercomputer.supercomputerId] });
 * const deleteConversation = yield* Azure.Discovery.DeleteConversation(workspace);
 *
 * // runtime
 * const result = yield* deleteConversation({ conversationName: "kickoff" });
 *
 * // layer
 * Effect.provide(Azure.Discovery.DeleteConversationHttp)
 * ```
 *
 * @binding
 * @category Discovery
 */
export interface DeleteConversation extends Binding.Service<
  DeleteConversation,
  "Azure.Discovery.DeleteConversation",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: DeleteConversationRequest,
    ) => Effect.Effect<
      discovery.DeleteConversationResponse,
      discovery.DeleteConversationError,
      RuntimeContext
    >
  >
> {}

export const DeleteConversation = Binding.Service<DeleteConversation>(
  "Azure.Discovery.DeleteConversation",
);
