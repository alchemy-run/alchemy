import type * as discovery from "@distilled.cloud/azure/discovery-workspace";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Workspace } from "./Workspace.ts";

/**
 * `GetInvestigationOperationStatus` request without `endpoint`, which the bound
 * Discovery workspace (its `workspaceApiUri`) supplies.
 */
export interface GetInvestigationOperationStatusRequest extends Omit<
  discovery.GetInvestigationOperationStatusRequest,
  "endpoint"
> {}

/**
 * Read the status of an investigation's long-running operation.
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
 * Provide {@link GetInvestigationOperationStatusHttp}.
 *
 * ### Calling GetInvestigationOperationStatus
 * **Example:** GetInvestigationOperationStatus from a Function
 * ```typescript
 * // init
 * const workspace = yield* Azure.Discovery.Workspace("lab", { supercomputerIds: [supercomputer.supercomputerId] });
 * const getInvestigationOperationStatus = yield* Azure.Discovery.GetInvestigationOperationStatus(workspace);
 *
 * // runtime
 * const result = yield* getInvestigationOperationStatus({ projectName: "materials", investigationName: "electrolytes", operationId });
 *
 * // layer
 * Effect.provide(Azure.Discovery.GetInvestigationOperationStatusHttp)
 * ```
 *
 * @binding
 * @category Discovery
 */
export interface GetInvestigationOperationStatus extends Binding.Service<
  GetInvestigationOperationStatus,
  "Azure.Discovery.GetInvestigationOperationStatus",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: GetInvestigationOperationStatusRequest,
    ) => Effect.Effect<
      discovery.InvestigationOperationStatus,
      discovery.GetInvestigationOperationStatusError,
      RuntimeContext
    >
  >
> {}

export const GetInvestigationOperationStatus = Binding.Service<GetInvestigationOperationStatus>(
  "Azure.Discovery.GetInvestigationOperationStatus",
);
