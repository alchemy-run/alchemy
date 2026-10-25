import type * as discovery from "@distilled.cloud/azure/discovery-workspace";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Workspace } from "./Workspace.ts";

/**
 * `GetInvestigationDiscoveryEngine` request without `endpoint`, which the bound
 * Discovery workspace (its `workspaceApiUri`) supplies.
 */
export interface GetInvestigationDiscoveryEngineRequest extends Omit<
  discovery.GetInvestigationDiscoveryEngineRequest,
  "endpoint"
> {}

/**
 * Read an investigation's discovery engine.
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
 * Provide {@link GetInvestigationDiscoveryEngineHttp}.
 *
 * ### Calling GetInvestigationDiscoveryEngine
 * **Example:** GetInvestigationDiscoveryEngine from a Function
 * ```typescript
 * // init
 * const workspace = yield* Azure.Discovery.Workspace("lab", { supercomputerIds: [supercomputer.supercomputerId] });
 * const getInvestigationDiscoveryEngine = yield* Azure.Discovery.GetInvestigationDiscoveryEngine(workspace);
 *
 * // runtime
 * const result = yield* getInvestigationDiscoveryEngine({ projectName: "materials", investigationName: "electrolytes" });
 *
 * // layer
 * Effect.provide(Azure.Discovery.GetInvestigationDiscoveryEngineHttp)
 * ```
 *
 * @binding
 * @category Discovery
 */
export interface GetInvestigationDiscoveryEngine extends Binding.Service<
  GetInvestigationDiscoveryEngine,
  "Azure.Discovery.GetInvestigationDiscoveryEngine",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: GetInvestigationDiscoveryEngineRequest,
    ) => Effect.Effect<
      discovery.DiscoveryEngine,
      discovery.GetInvestigationDiscoveryEngineError,
      RuntimeContext
    >
  >
> {}

export const GetInvestigationDiscoveryEngine = Binding.Service<GetInvestigationDiscoveryEngine>(
  "Azure.Discovery.GetInvestigationDiscoveryEngine",
);
