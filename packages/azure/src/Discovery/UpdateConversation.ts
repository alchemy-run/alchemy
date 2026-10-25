import type * as discovery from "@distilled.cloud/azure/discovery-workspace";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Workspace } from "./Workspace.ts";

/**
 * `UpdateConversation` request without `endpoint`, which the bound Discovery
 * workspace (its `workspaceApiUri`) supplies.
 */
export interface UpdateConversationRequest extends Omit<
  discovery.UpdateConversationRequest,
  "endpoint"
> {}

/**
 * Update a conversation.
 *
 * Binding assigns a custom role (`AzureDiscoveryConversationWriteRole`, one per
 * stack) with exactly the data action
 * `Microsoft.Discovery/workspaces/conversations/write`, on the bound workspace
 * only. The built-in **Microsoft Discovery Project Contributor** also manages
 * projects and investigations.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link UpdateConversationHttp}.
 *
 * ### Calling UpdateConversation
 * **Example:** UpdateConversation from a Function
 * ```typescript
 * // init
 * const workspace = yield* Azure.Discovery.Workspace("lab", { supercomputerIds: [supercomputer.supercomputerId] });
 * const updateConversation = yield* Azure.Discovery.UpdateConversation(workspace);
 *
 * // runtime
 * const result = yield* updateConversation({ conversationName: "kickoff" });
 *
 * // layer
 * Effect.provide(Azure.Discovery.UpdateConversationHttp)
 * ```
 *
 * @binding
 * @category Discovery
 */
export interface UpdateConversation extends Binding.Service<
  UpdateConversation,
  "Azure.Discovery.UpdateConversation",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: UpdateConversationRequest,
    ) => Effect.Effect<discovery.Conversation, discovery.UpdateConversationError, RuntimeContext>
  >
> {}

export const UpdateConversation = Binding.Service<UpdateConversation>(
  "Azure.Discovery.UpdateConversation",
);
