import type * as discovery from "@distilled.cloud/azure/discovery-workspace";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Workspace } from "./Workspace.ts";

/**
 * `ListTasks` request without `endpoint`, which the bound Discovery workspace
 * (its `workspaceApiUri`) supplies.
 */
export interface ListTasksRequest extends Omit<discovery.ListTasksRequest, "endpoint"> {}

/**
 * List an investigation's tasks. One page per call: pass `nextLink` for the
 * next.
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
 * Provide {@link ListTasksHttp}.
 *
 * ### Calling ListTasks
 * **Example:** ListTasks from a Function
 * ```typescript
 * // init
 * const workspace = yield* Azure.Discovery.Workspace("lab", { supercomputerIds: [supercomputer.supercomputerId] });
 * const listTasks = yield* Azure.Discovery.ListTasks(workspace);
 *
 * // runtime
 * const result = yield* listTasks({ projectName: "materials", investigationName: "electrolytes" });
 *
 * // layer
 * Effect.provide(Azure.Discovery.ListTasksHttp)
 * ```
 *
 * @binding
 * @category Discovery
 */
export interface ListTasks extends Binding.Service<
  ListTasks,
  "Azure.Discovery.ListTasks",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: ListTasksRequest,
    ) => Effect.Effect<discovery.PagedTask, discovery.ListTasksError, RuntimeContext>
  >
> {}

export const ListTasks = Binding.Service<ListTasks>("Azure.Discovery.ListTasks");
