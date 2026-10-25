import type * as discovery from "@distilled.cloud/azure/discovery-workspace";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Workspace } from "./Workspace.ts";

/**
 * `DeleteInvestigation` request without `endpoint`, which the bound Discovery
 * workspace (its `workspaceApiUri`) supplies.
 */
export interface DeleteInvestigationRequest extends Omit<
  discovery.DeleteInvestigationRequest,
  "endpoint"
> {}

/**
 * Delete an investigation.
 *
 * Binding assigns a custom role (`AzureDiscoveryInvestigationDeleteRole`, one
 * per stack) with exactly the data action
 * `Microsoft.Discovery/workspaces/projects/investigations/delete`, on the bound
 * workspace only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link DeleteInvestigationHttp}.
 *
 * ### Calling DeleteInvestigation
 * **Example:** DeleteInvestigation from a Function
 * ```typescript
 * // init
 * const workspace = yield* Azure.Discovery.Workspace("lab", { supercomputerIds: [supercomputer.supercomputerId] });
 * const deleteInvestigation = yield* Azure.Discovery.DeleteInvestigation(workspace);
 *
 * // runtime
 * const result = yield* deleteInvestigation({ projectName: "materials", investigationName: "electrolytes" });
 *
 * // layer
 * Effect.provide(Azure.Discovery.DeleteInvestigationHttp)
 * ```
 *
 * @binding
 * @category Discovery
 */
export interface DeleteInvestigation extends Binding.Service<
  DeleteInvestigation,
  "Azure.Discovery.DeleteInvestigation",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: DeleteInvestigationRequest,
    ) => Effect.Effect<
      discovery.DeleteInvestigationResponse,
      discovery.DeleteInvestigationError,
      RuntimeContext
    >
  >
> {}

export const DeleteInvestigation = Binding.Service<DeleteInvestigation>(
  "Azure.Discovery.DeleteInvestigation",
);
