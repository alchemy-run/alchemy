import type * as discovery from "@distilled.cloud/azure/discovery-workspace";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Workspace } from "./Workspace.ts";

/**
 * `CancelToolRunLro` request without `endpoint`, which the bound Discovery
 * workspace (its `workspaceApiUri`) supplies.
 */
export interface CancelToolRunRequest extends Omit<discovery.CancelToolRunLroRequest, "endpoint"> {}

/**
 * Cancel a tool run.
 *
 * Binding assigns a custom role (`AzureDiscoveryToolOperationCancelRole`, one
 * per stack) with exactly the data action
 * `Microsoft.Discovery/workspaces/projects/operations/cancel/action`, on the
 * bound workspace only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link CancelToolRunHttp}.
 *
 * ### Calling CancelToolRun
 * **Example:** CancelToolRun from a Function
 * ```typescript
 * // init
 * const workspace = yield* Azure.Discovery.Workspace("lab", { supercomputerIds: [supercomputer.supercomputerId] });
 * const cancelToolRun = yield* Azure.Discovery.CancelToolRun(workspace);
 *
 * // runtime
 * const result = yield* cancelToolRun({ projectName: "materials", operationId });
 *
 * // layer
 * Effect.provide(Azure.Discovery.CancelToolRunHttp)
 * ```
 *
 * @binding
 * @category Discovery
 */
export interface CancelToolRun extends Binding.Service<
  CancelToolRun,
  "Azure.Discovery.CancelToolRun",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: CancelToolRunRequest,
    ) => Effect.Effect<
      discovery.CancelToolRunLroResponse,
      discovery.CancelToolRunLroError,
      RuntimeContext
    >
  >
> {}

export const CancelToolRun = Binding.Service<CancelToolRun>("Azure.Discovery.CancelToolRun");
