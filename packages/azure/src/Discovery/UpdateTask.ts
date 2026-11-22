import type * as discovery from "@distilled.cloud/azure/discovery-workspace";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Workspace } from "./Workspace.ts";

/**
 * `UpdateTask` request without `endpoint`, which the bound Discovery workspace
 * (its `workspaceApiUri`) supplies.
 */
export interface UpdateTaskRequest extends Omit<discovery.UpdateTaskRequest, "endpoint"> {}

/**
 * Update an investigation task.
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
 * Provide {@link UpdateTaskHttp}.
 *
 * ### Calling UpdateTask
 * **Example:** UpdateTask from a Function
 * ```typescript
 * // init
 * const workspace = yield* Azure.Discovery.Workspace("lab", { supercomputerIds: [supercomputer.supercomputerId] });
 * const updateTask = yield* Azure.Discovery.UpdateTask(workspace);
 *
 * // runtime
 * const result = yield* updateTask({ projectName: "materials", investigationName: "electrolytes", taskName: "screen" });
 *
 * // layer
 * Effect.provide(Azure.Discovery.UpdateTaskHttp)
 * ```
 *
 * @binding
 * @category Discovery
 */
export interface UpdateTask extends Binding.Service<
  UpdateTask,
  "Azure.Discovery.UpdateTask",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: UpdateTaskRequest,
    ) => Effect.Effect<discovery.Task, discovery.UpdateTaskError, RuntimeContext>
  >
> {}

export const UpdateTask = Binding.Service<UpdateTask>("Azure.Discovery.UpdateTask");
