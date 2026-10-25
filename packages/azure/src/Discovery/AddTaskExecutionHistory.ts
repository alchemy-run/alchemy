import type * as discovery from "@distilled.cloud/azure/discovery-workspace";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Workspace } from "./Workspace.ts";

/**
 * `AddTaskExecutionHistory` request without `endpoint`, which the bound
 * Discovery workspace (its `workspaceApiUri`) supplies.
 */
export interface AddTaskExecutionHistoryRequest extends Omit<
  discovery.AddTaskExecutionHistoryRequest,
  "endpoint"
> {}

/**
 * Add an execution-history entry to an investigation task.
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
 * Provide {@link AddTaskExecutionHistoryHttp}.
 *
 * ### Calling AddTaskExecutionHistory
 * **Example:** AddTaskExecutionHistory from a Function
 * ```typescript
 * // init
 * const workspace = yield* Azure.Discovery.Workspace("lab", { supercomputerIds: [supercomputer.supercomputerId] });
 * const addTaskExecutionHistory = yield* Azure.Discovery.AddTaskExecutionHistory(workspace);
 *
 * // runtime
 * const result = yield* addTaskExecutionHistory({ projectName: "materials", investigationName: "electrolytes", taskName: "screen", createdAt: new Date().toISOString(), action: "started", createdBy: "agent", createdByType: "Agent" });
 *
 * // layer
 * Effect.provide(Azure.Discovery.AddTaskExecutionHistoryHttp)
 * ```
 *
 * @binding
 * @category Discovery
 */
export interface AddTaskExecutionHistory extends Binding.Service<
  AddTaskExecutionHistory,
  "Azure.Discovery.AddTaskExecutionHistory",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: AddTaskExecutionHistoryRequest,
    ) => Effect.Effect<discovery.Task, discovery.AddTaskExecutionHistoryError, RuntimeContext>
  >
> {}

export const AddTaskExecutionHistory = Binding.Service<AddTaskExecutionHistory>(
  "Azure.Discovery.AddTaskExecutionHistory",
);
