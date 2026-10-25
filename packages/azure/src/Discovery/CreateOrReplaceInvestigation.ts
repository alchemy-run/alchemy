import type * as discovery from "@distilled.cloud/azure/discovery-workspace";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Workspace } from "./Workspace.ts";

/**
 * `InvestigationsCreateOrReplace` request without `endpoint`, which the bound
 * Discovery workspace (its `workspaceApiUri`) supplies.
 */
export interface CreateOrReplaceInvestigationRequest extends Omit<
  discovery.InvestigationsCreateOrReplaceRequest,
  "endpoint"
> {}

/**
 * Create or replace an investigation (`PUT`).
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
 * Provide {@link CreateOrReplaceInvestigationHttp}.
 *
 * ### Calling CreateOrReplaceInvestigation
 * **Example:** CreateOrReplaceInvestigation from a Function
 * ```typescript
 * // init
 * const workspace = yield* Azure.Discovery.Workspace("lab", { supercomputerIds: [supercomputer.supercomputerId] });
 * const createOrReplaceInvestigation = yield* Azure.Discovery.CreateOrReplaceInvestigation(workspace);
 *
 * // runtime
 * const result = yield* createOrReplaceInvestigation({ projectName: "materials", investigationName: "electrolytes" });
 *
 * // layer
 * Effect.provide(Azure.Discovery.CreateOrReplaceInvestigationHttp)
 * ```
 *
 * @binding
 * @category Discovery
 */
export interface CreateOrReplaceInvestigation extends Binding.Service<
  CreateOrReplaceInvestigation,
  "Azure.Discovery.CreateOrReplaceInvestigation",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: CreateOrReplaceInvestigationRequest,
    ) => Effect.Effect<
      discovery.Investigation,
      discovery.InvestigationsCreateOrReplaceError,
      RuntimeContext
    >
  >
> {}

export const CreateOrReplaceInvestigation = Binding.Service<CreateOrReplaceInvestigation>(
  "Azure.Discovery.CreateOrReplaceInvestigation",
);
