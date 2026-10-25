import type * as discovery from "@distilled.cloud/azure/discovery-workspace";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Workspace } from "./Workspace.ts";

/**
 * `GetConversation` request without `endpoint`, which the bound Discovery
 * workspace (its `workspaceApiUri`) supplies.
 */
export interface GetConversationRequest extends Omit<
  discovery.GetConversationRequest,
  "endpoint"
> {}

/**
 * Read a conversation.
 *
 * Binding assigns a custom role (`AzureDiscoveryConversationReadRole`, one per
 * stack) with exactly the data action
 * `Microsoft.Discovery/workspaces/conversations/read`, on the bound workspace
 * only. The built-in **Microsoft Discovery Project Reader** also reads
 * investigations.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetConversationHttp}.
 *
 * ### Calling GetConversation
 * **Example:** GetConversation from a Function
 * ```typescript
 * // init
 * const workspace = yield* Azure.Discovery.Workspace("lab", { supercomputerIds: [supercomputer.supercomputerId] });
 * const getConversation = yield* Azure.Discovery.GetConversation(workspace);
 *
 * // runtime
 * const result = yield* getConversation({ conversationName: "kickoff" });
 *
 * // layer
 * Effect.provide(Azure.Discovery.GetConversationHttp)
 * ```
 *
 * @binding
 * @category Discovery
 */
export interface GetConversation extends Binding.Service<
  GetConversation,
  "Azure.Discovery.GetConversation",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: GetConversationRequest,
    ) => Effect.Effect<discovery.Conversation, discovery.GetConversationError, RuntimeContext>
  >
> {}

export const GetConversation = Binding.Service<GetConversation>("Azure.Discovery.GetConversation");
