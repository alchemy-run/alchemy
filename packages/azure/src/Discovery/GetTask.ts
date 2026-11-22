import type * as discovery from "@distilled.cloud/azure/discovery-workspace";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Workspace } from "./Workspace.ts";

/**
 * `GetTask` request without `endpoint`, which the bound Discovery workspace
 * (its `workspaceApiUri`) supplies.
 */
export interface GetTaskRequest extends Omit<discovery.GetTaskRequest, "endpoint"> {}

/**
 * Read an investigation task.
 *
 * Binding assigns a custom role (`AzureDiscoveryInvestigationReadRole`, one per
 * stack) with exactly the data action
 * `Microsoft.Discovery/workspaces/projects/investigations/read`, on the bound
 * workspace only. The built-in **Microsoft Discovery Project Reader** also
 * reads conversations.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetTaskHttp}.
 *
 * ### Calling GetTask
 * **Example:** GetTask from a Function
 * ```typescript
 * // init
 * const workspace = yield* Azure.Discovery.Workspace("lab", { supercomputerIds: [supercomputer.supercomputerId] });
 * const getTask = yield* Azure.Discovery.GetTask(workspace);
 *
 * // runtime
 * const result = yield* getTask({ projectName: "materials", investigationName: "electrolytes", taskName: "screen" });
 *
 * // layer
 * Effect.provide(Azure.Discovery.GetTaskHttp)
 * ```
 *
 * @binding
 * @category Discovery
 */
export interface GetTask extends Binding.Service<
  GetTask,
  "Azure.Discovery.GetTask",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: GetTaskRequest,
    ) => Effect.Effect<discovery.Task, discovery.GetTaskError, RuntimeContext>
  >
> {}

export const GetTask = Binding.Service<GetTask>("Azure.Discovery.GetTask");
