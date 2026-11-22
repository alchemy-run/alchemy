import type * as discovery from "@distilled.cloud/azure/discovery-workspace";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Workspace } from "./Workspace.ts";

/**
 * `StartTask` request without `endpoint`, which the bound Discovery workspace
 * (its `workspaceApiUri`) supplies.
 */
export interface StartTaskRequest extends Omit<discovery.StartTaskRequest, "endpoint"> {}

/**
 * Start an investigation task.
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
 * Provide {@link StartTaskHttp}.
 *
 * ### Calling StartTask
 * **Example:** StartTask from a Function
 * ```typescript
 * // init
 * const workspace = yield* Azure.Discovery.Workspace("lab", { supercomputerIds: [supercomputer.supercomputerId] });
 * const startTask = yield* Azure.Discovery.StartTask(workspace);
 *
 * // runtime
 * const result = yield* startTask({ projectName: "materials", investigationName: "electrolytes", taskName: "screen" });
 *
 * // layer
 * Effect.provide(Azure.Discovery.StartTaskHttp)
 * ```
 *
 * @binding
 * @category Discovery
 */
export interface StartTask extends Binding.Service<
  StartTask,
  "Azure.Discovery.StartTask",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: StartTaskRequest,
    ) => Effect.Effect<discovery.Task, discovery.StartTaskError, RuntimeContext>
  >
> {}

export const StartTask = Binding.Service<StartTask>("Azure.Discovery.StartTask");
