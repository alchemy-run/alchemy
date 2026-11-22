import type * as discovery from "@distilled.cloud/azure/discovery-workspace";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Workspace } from "./Workspace.ts";

/**
 * `GetInvestigationDiscoveryEngineMemory` request without `endpoint`, which the
 * bound Discovery workspace (its `workspaceApiUri`) supplies.
 */
export interface GetInvestigationDiscoveryEngineMemoryRequest extends Omit<
  discovery.GetInvestigationDiscoveryEngineMemoryRequest,
  "endpoint"
> {}

/**
 * Read the working memory of an investigation's discovery engine.
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
 * Provide {@link GetInvestigationDiscoveryEngineMemoryHttp}.
 *
 * ### Calling GetInvestigationDiscoveryEngineMemory
 * **Example:** GetInvestigationDiscoveryEngineMemory from a Function
 * ```typescript
 * // init
 * const workspace = yield* Azure.Discovery.Workspace("lab", { supercomputerIds: [supercomputer.supercomputerId] });
 * const getInvestigationDiscoveryEngineMemory = yield* Azure.Discovery.GetInvestigationDiscoveryEngineMemory(workspace);
 *
 * // runtime
 * const result = yield* getInvestigationDiscoveryEngineMemory({ projectName: "materials", investigationName: "electrolytes" });
 *
 * // layer
 * Effect.provide(Azure.Discovery.GetInvestigationDiscoveryEngineMemoryHttp)
 * ```
 *
 * @binding
 * @category Discovery
 */
export interface GetInvestigationDiscoveryEngineMemory extends Binding.Service<
  GetInvestigationDiscoveryEngineMemory,
  "Azure.Discovery.GetInvestigationDiscoveryEngineMemory",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: GetInvestigationDiscoveryEngineMemoryRequest,
    ) => Effect.Effect<
      discovery.PagedWorkingMemoryEntry,
      discovery.GetInvestigationDiscoveryEngineMemoryError,
      RuntimeContext
    >
  >
> {}

export const GetInvestigationDiscoveryEngineMemory =
  Binding.Service<GetInvestigationDiscoveryEngineMemory>(
    "Azure.Discovery.GetInvestigationDiscoveryEngineMemory",
  );
