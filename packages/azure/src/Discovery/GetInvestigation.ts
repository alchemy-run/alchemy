import type * as discovery from "@distilled.cloud/azure/discovery-workspace";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Workspace } from "./Workspace.ts";

/**
 * `GetInvestigation` request without `endpoint`, which the bound Discovery
 * workspace (its `workspaceApiUri`) supplies.
 */
export interface GetInvestigationRequest extends Omit<
  discovery.GetInvestigationRequest,
  "endpoint"
> {}

/**
 * Read an investigation.
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
 * Provide {@link GetInvestigationHttp}.
 *
 * ### Calling GetInvestigation
 * **Example:** GetInvestigation from a Function
 * ```typescript
 * // init
 * const workspace = yield* Azure.Discovery.Workspace("lab", { supercomputerIds: [supercomputer.supercomputerId] });
 * const getInvestigation = yield* Azure.Discovery.GetInvestigation(workspace);
 *
 * // runtime
 * const result = yield* getInvestigation({ projectName: "materials", investigationName: "electrolytes" });
 *
 * // layer
 * Effect.provide(Azure.Discovery.GetInvestigationHttp)
 * ```
 *
 * @binding
 * @category Discovery
 */
export interface GetInvestigation extends Binding.Service<
  GetInvestigation,
  "Azure.Discovery.GetInvestigation",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: GetInvestigationRequest,
    ) => Effect.Effect<discovery.Investigation, discovery.GetInvestigationError, RuntimeContext>
  >
> {}

export const GetInvestigation = Binding.Service<GetInvestigation>(
  "Azure.Discovery.GetInvestigation",
);
