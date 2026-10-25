import type * as discovery from "@distilled.cloud/azure/discovery-workspace";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Workspace } from "./Workspace.ts";

/**
 * `ListInvestigations` request without `endpoint`, which the bound Discovery
 * workspace (its `workspaceApiUri`) supplies.
 */
export interface ListInvestigationsRequest extends Omit<
  discovery.ListInvestigationsRequest,
  "endpoint"
> {}

/**
 * List a project's investigations.
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
 * Provide {@link ListInvestigationsHttp}.
 *
 * ### Calling ListInvestigations
 * **Example:** ListInvestigations from a Function
 * ```typescript
 * // init
 * const workspace = yield* Azure.Discovery.Workspace("lab", { supercomputerIds: [supercomputer.supercomputerId] });
 * const listInvestigations = yield* Azure.Discovery.ListInvestigations(workspace);
 *
 * // runtime
 * const result = yield* listInvestigations({ projectName: "materials" });
 *
 * // layer
 * Effect.provide(Azure.Discovery.ListInvestigationsHttp)
 * ```
 *
 * @binding
 * @category Discovery
 */
export interface ListInvestigations extends Binding.Service<
  ListInvestigations,
  "Azure.Discovery.ListInvestigations",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: ListInvestigationsRequest,
    ) => Effect.Effect<
      discovery.PagedInvestigation,
      discovery.ListInvestigationsError,
      RuntimeContext
    >
  >
> {}

export const ListInvestigations = Binding.Service<ListInvestigations>(
  "Azure.Discovery.ListInvestigations",
);
