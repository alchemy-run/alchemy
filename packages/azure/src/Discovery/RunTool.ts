import type * as discovery from "@distilled.cloud/azure/discovery-workspace";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Workspace } from "./Workspace.ts";

/**
 * `RunTool` request without `endpoint`, which the bound Discovery workspace
 * (its `workspaceApiUri`) supplies.
 */
export interface RunToolRequest extends Omit<discovery.RunToolRequest, "endpoint"> {}

/**
 * Run a tool on a project's node pools.
 *
 * Binding assigns a custom role (`AzureDiscoveryToolRunRole`, one per stack)
 * with exactly the data action
 * `Microsoft.Discovery/workspaces/projects/runTool/action`, on the bound
 * workspace only. The tool also runs on the node pools you name: the caller
 * needs `Microsoft.Discovery/supercomputers/nodepools/run/action` on them,
 * which this binding does not grant.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link RunToolHttp}.
 *
 * ### Calling RunTool
 * **Example:** RunTool from a Function
 * ```typescript
 * // init
 * const workspace = yield* Azure.Discovery.Workspace("lab", { supercomputerIds: [supercomputer.supercomputerId] });
 * const runTool = yield* Azure.Discovery.RunTool(workspace);
 *
 * // runtime
 * const result = yield* runTool({ projectName: "materials", toolId, nodePoolIds: [nodePoolId] });
 *
 * // layer
 * Effect.provide(Azure.Discovery.RunToolHttp)
 * ```
 *
 * @binding
 * @category Discovery
 */
export interface RunTool extends Binding.Service<
  RunTool,
  "Azure.Discovery.RunTool",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: RunToolRequest,
    ) => Effect.Effect<discovery.RunToolResponse, discovery.RunToolError, RuntimeContext>
  >
> {}

export const RunTool = Binding.Service<RunTool>("Azure.Discovery.RunTool");
