import type * as discovery from "@distilled.cloud/azure/discovery-workspace";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Workspace } from "./Workspace.ts";

/**
 * `CreateConversation` request without `endpoint`, which the bound Discovery
 * workspace (its `workspaceApiUri`) supplies.
 */
export interface CreateConversationRequest extends Omit<
  discovery.CreateConversationRequest,
  "endpoint"
> {}

/**
 * Create a conversation in a project.
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
 * Provide {@link CreateConversationHttp}.
 *
 * ### Calling CreateConversation
 * **Example:** CreateConversation from a Function
 * ```typescript
 * // init
 * const workspace = yield* Azure.Discovery.Workspace("lab", { supercomputerIds: [supercomputer.supercomputerId] });
 * const createConversation = yield* Azure.Discovery.CreateConversation(workspace);
 *
 * // runtime
 * const result = yield* createConversation({ projectName: "materials" });
 *
 * // layer
 * Effect.provide(Azure.Discovery.CreateConversationHttp)
 * ```
 *
 * @binding
 * @category Discovery
 */
export interface CreateConversation extends Binding.Service<
  CreateConversation,
  "Azure.Discovery.CreateConversation",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: CreateConversationRequest,
    ) => Effect.Effect<discovery.Conversation, discovery.CreateConversationError, RuntimeContext>
  >
> {}

export const CreateConversation = Binding.Service<CreateConversation>(
  "Azure.Discovery.CreateConversation",
);
