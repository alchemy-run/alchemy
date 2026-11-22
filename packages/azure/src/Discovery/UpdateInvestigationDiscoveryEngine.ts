import type * as discovery from "@distilled.cloud/azure/discovery-workspace";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Workspace } from "./Workspace.ts";

/**
 * `UpdateInvestigationDiscoveryEngine` request without `endpoint`, which the
 * bound Discovery workspace (its `workspaceApiUri`) supplies.
 */
export interface UpdateInvestigationDiscoveryEngineRequest extends Omit<
  discovery.UpdateInvestigationDiscoveryEngineRequest,
  "endpoint"
> {}

/**
 * Update an investigation's discovery engine.
 *
 * Binding assigns a custom role (`AzureDiscoveryInvestigationWriteRole`, one
 * per stack) with exactly the data action
 * `Microsoft.Discovery/workspaces/projects/investigations/write`, on the bound
 * workspace only. The built-in **Microsoft Discovery Project Contributor** also
 * manages projects and conversations.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link UpdateInvestigationDiscoveryEngineHttp}.
 *
 * ### Calling UpdateInvestigationDiscoveryEngine
 * **Example:** UpdateInvestigationDiscoveryEngine from a Function
 * ```typescript
 * // init
 * const workspace = yield* Azure.Discovery.Workspace("lab", { supercomputerIds: [supercomputer.supercomputerId] });
 * const updateInvestigationDiscoveryEngine = yield* Azure.Discovery.UpdateInvestigationDiscoveryEngine(workspace);
 *
 * // runtime
 * const result = yield* updateInvestigationDiscoveryEngine({ projectName: "materials", investigationName: "electrolytes" });
 *
 * // layer
 * Effect.provide(Azure.Discovery.UpdateInvestigationDiscoveryEngineHttp)
 * ```
 *
 * @binding
 * @category Discovery
 */
export interface UpdateInvestigationDiscoveryEngine extends Binding.Service<
  UpdateInvestigationDiscoveryEngine,
  "Azure.Discovery.UpdateInvestigationDiscoveryEngine",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: UpdateInvestigationDiscoveryEngineRequest,
    ) => Effect.Effect<
      discovery.DiscoveryEngine,
      discovery.UpdateInvestigationDiscoveryEngineError,
      RuntimeContext
    >
  >
> {}

export const UpdateInvestigationDiscoveryEngine =
  Binding.Service<UpdateInvestigationDiscoveryEngine>(
    "Azure.Discovery.UpdateInvestigationDiscoveryEngine",
  );
