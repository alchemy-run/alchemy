import type * as discovery from "@distilled.cloud/azure/discovery-workspace";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Workspace } from "./Workspace.ts";

/**
 * `CreateTask` request without `endpoint`, which the bound Discovery workspace
 * (its `workspaceApiUri`) supplies.
 */
export interface CreateTaskRequest extends Omit<discovery.CreateTaskRequest, "endpoint"> {}

/**
 * Create an investigation task.
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
 * Provide {@link CreateTaskHttp}.
 *
 * ### Calling CreateTask
 * **Example:** CreateTask from a Function
 * ```typescript
 * // init
 * const workspace = yield* Azure.Discovery.Workspace("lab", { supercomputerIds: [supercomputer.supercomputerId] });
 * const createTask = yield* Azure.Discovery.CreateTask(workspace);
 *
 * // runtime
 * const result = yield* createTask({ projectName: "materials", investigationName: "electrolytes" });
 *
 * // layer
 * Effect.provide(Azure.Discovery.CreateTaskHttp)
 * ```
 *
 * @binding
 * @category Discovery
 */
export interface CreateTask extends Binding.Service<
  CreateTask,
  "Azure.Discovery.CreateTask",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: CreateTaskRequest,
    ) => Effect.Effect<discovery.Task, discovery.CreateTaskError, RuntimeContext>
  >
> {}

export const CreateTask = Binding.Service<CreateTask>("Azure.Discovery.CreateTask");
