import type * as discovery from "@distilled.cloud/azure/discovery-workspace";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Workspace } from "./Workspace.ts";

/**
 * `AddTaskComment` request without `endpoint`, which the bound Discovery
 * workspace (its `workspaceApiUri`) supplies.
 */
export interface AddTaskCommentRequest extends Omit<discovery.AddTaskCommentRequest, "endpoint"> {}

/**
 * Add a comment to an investigation task.
 *
 * Binding assigns a custom role (`AzureDiscoveryInvestigationWriteRole`, one
 * per stack) with exactly the data action
 * `Microsoft.Discovery/workspaces/projects/investigations/write`, on the bound
 * workspace only. The built-in **Microsoft Discovery Project Contributor** also
 * manages projects and conversations.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link AddTaskCommentHttp}.
 *
 * ### Calling AddTaskComment
 * **Example:** AddTaskComment from a Function
 * ```typescript
 * // init
 * const workspace = yield* Azure.Discovery.Workspace("lab", { supercomputerIds: [supercomputer.supercomputerId] });
 * const addTaskComment = yield* Azure.Discovery.AddTaskComment(workspace);
 *
 * // runtime
 * const result = yield* addTaskComment({ projectName: "materials", investigationName: "electrolytes", taskName: "screen", createdBy: "agent", createdByType: "Agent", text: "Screened 40 candidates." });
 *
 * // layer
 * Effect.provide(Azure.Discovery.AddTaskCommentHttp)
 * ```
 *
 * @binding
 * @category Discovery
 */
export interface AddTaskComment extends Binding.Service<
  AddTaskComment,
  "Azure.Discovery.AddTaskComment",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: AddTaskCommentRequest,
    ) => Effect.Effect<discovery.Task, discovery.AddTaskCommentError, RuntimeContext>
  >
> {}

export const AddTaskComment = Binding.Service<AddTaskComment>("Azure.Discovery.AddTaskComment");
