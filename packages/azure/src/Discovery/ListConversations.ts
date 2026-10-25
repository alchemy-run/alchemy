import type * as discovery from "@distilled.cloud/azure/discovery-workspace";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Workspace } from "./Workspace.ts";

/**
 * `ListConversations` request without `endpoint`, which the bound Discovery
 * workspace (its `workspaceApiUri`) supplies.
 */
export interface ListConversationsRequest extends Omit<
  discovery.ListConversationsRequest,
  "endpoint"
> {}

/**
 * List the workspace's conversations.
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
 * Provide {@link ListConversationsHttp}.
 *
 * ### Calling ListConversations
 * **Example:** ListConversations from a Function
 * ```typescript
 * // init
 * const workspace = yield* Azure.Discovery.Workspace("lab", { supercomputerIds: [supercomputer.supercomputerId] });
 * const listConversations = yield* Azure.Discovery.ListConversations(workspace);
 *
 * // runtime
 * const result = yield* listConversations();
 *
 * // layer
 * Effect.provide(Azure.Discovery.ListConversationsHttp)
 * ```
 *
 * @binding
 * @category Discovery
 */
export interface ListConversations extends Binding.Service<
  ListConversations,
  "Azure.Discovery.ListConversations",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request?: ListConversationsRequest,
    ) => Effect.Effect<
      discovery.PagedConversation,
      discovery.ListConversationsError,
      RuntimeContext
    >
  >
> {}

export const ListConversations = Binding.Service<ListConversations>(
  "Azure.Discovery.ListConversations",
);
