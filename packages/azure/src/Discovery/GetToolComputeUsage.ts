import type * as discovery from "@distilled.cloud/azure/discovery-workspace";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Workspace } from "./Workspace.ts";

/**
 * `GetToolComputeUsage` request without `endpoint`, which the bound Discovery
 * workspace (its `workspaceApiUri`) supplies.
 */
export interface GetToolComputeUsageRequest extends Omit<
  discovery.GetToolComputeUsageRequest,
  "endpoint"
> {}

/**
 * Read a project's tool compute usage.
 *
 * Binding assigns a custom role (`AzureDiscoveryToolOperationReadRole`, one per
 * stack) with exactly the data action
 * `Microsoft.Discovery/workspaces/projects/operations/read`, on the bound
 * workspace only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetToolComputeUsageHttp}.
 *
 * ### Calling GetToolComputeUsage
 * **Example:** GetToolComputeUsage from a Function
 * ```typescript
 * // init
 * const workspace = yield* Azure.Discovery.Workspace("lab", { supercomputerIds: [supercomputer.supercomputerId] });
 * const getToolComputeUsage = yield* Azure.Discovery.GetToolComputeUsage(workspace);
 *
 * // runtime
 * const result = yield* getToolComputeUsage({ projectName: "materials" });
 *
 * // layer
 * Effect.provide(Azure.Discovery.GetToolComputeUsageHttp)
 * ```
 *
 * @binding
 * @category Discovery
 */
export interface GetToolComputeUsage extends Binding.Service<
  GetToolComputeUsage,
  "Azure.Discovery.GetToolComputeUsage",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: GetToolComputeUsageRequest,
    ) => Effect.Effect<discovery.ComputeUsage, discovery.GetToolComputeUsageError, RuntimeContext>
  >
> {}

export const GetToolComputeUsage = Binding.Service<GetToolComputeUsage>(
  "Azure.Discovery.GetToolComputeUsage",
);
