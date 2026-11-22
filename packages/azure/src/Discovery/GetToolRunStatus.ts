import type * as discovery from "@distilled.cloud/azure/discovery-workspace";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Workspace } from "./Workspace.ts";

/**
 * `GetToolRunStatus` request without `endpoint`, which the bound Discovery
 * workspace (its `workspaceApiUri`) supplies.
 */
export interface GetToolRunStatusRequest extends Omit<
  discovery.GetToolRunStatusRequest,
  "endpoint"
> {}

/**
 * Read the status of a tool run.
 *
 * Binding assigns a custom role (`AzureDiscoveryToolOperationReadRole`, one per
 * stack) with exactly the data action
 * `Microsoft.Discovery/workspaces/projects/operations/read`, on the bound
 * workspace only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetToolRunStatusHttp}.
 *
 * ### Calling GetToolRunStatus
 * **Example:** GetToolRunStatus from a Function
 * ```typescript
 * // init
 * const workspace = yield* Azure.Discovery.Workspace("lab", { supercomputerIds: [supercomputer.supercomputerId] });
 * const getToolRunStatus = yield* Azure.Discovery.GetToolRunStatus(workspace);
 *
 * // runtime
 * const result = yield* getToolRunStatus({ projectName: "materials", operationId });
 *
 * // layer
 * Effect.provide(Azure.Discovery.GetToolRunStatusHttp)
 * ```
 *
 * @binding
 * @category Discovery
 */
export interface GetToolRunStatus extends Binding.Service<
  GetToolRunStatus,
  "Azure.Discovery.GetToolRunStatus",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: GetToolRunStatusRequest,
    ) => Effect.Effect<
      discovery.GetToolRunStatusResponse,
      discovery.GetToolRunStatusError,
      RuntimeContext
    >
  >
> {}

export const GetToolRunStatus = Binding.Service<GetToolRunStatus>(
  "Azure.Discovery.GetToolRunStatus",
);
