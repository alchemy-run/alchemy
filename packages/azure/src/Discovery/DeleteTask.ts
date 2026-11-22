import type * as discovery from "@distilled.cloud/azure/discovery-workspace";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Workspace } from "./Workspace.ts";

/**
 * `DeleteTask` request without `endpoint`, which the bound Discovery workspace
 * (its `workspaceApiUri`) supplies.
 */
export interface DeleteTaskRequest extends Omit<discovery.DeleteTaskRequest, "endpoint"> {}

/**
 * Delete an investigation task.
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
 * Provide {@link DeleteTaskHttp}.
 *
 * ### Calling DeleteTask
 * **Example:** DeleteTask from a Function
 * ```typescript
 * // init
 * const workspace = yield* Azure.Discovery.Workspace("lab", { supercomputerIds: [supercomputer.supercomputerId] });
 * const deleteTask = yield* Azure.Discovery.DeleteTask(workspace);
 *
 * // runtime
 * const result = yield* deleteTask({ projectName: "materials", investigationName: "electrolytes", taskName: "screen" });
 *
 * // layer
 * Effect.provide(Azure.Discovery.DeleteTaskHttp)
 * ```
 *
 * @binding
 * @category Discovery
 */
export interface DeleteTask extends Binding.Service<
  DeleteTask,
  "Azure.Discovery.DeleteTask",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: DeleteTaskRequest,
    ) => Effect.Effect<discovery.DeleteTaskResponse, discovery.DeleteTaskError, RuntimeContext>
  >
> {}

export const DeleteTask = Binding.Service<DeleteTask>("Azure.Discovery.DeleteTask");
