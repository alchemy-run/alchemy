import type * as discovery from "@distilled.cloud/azure/discovery-workspace";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Workspace } from "./Workspace.ts";

/**
 * `GetToolOperations` request without `endpoint`, which the bound Discovery
 * workspace (its `workspaceApiUri`) supplies.
 */
export interface GetToolOperationsRequest extends Omit<
  discovery.GetToolOperationsRequest,
  "endpoint"
> {}

/**
 * List a project's tool runs.
 *
 * Binding assigns a custom role (`AzureDiscoveryToolOperationReadRole`, one per
 * stack) with exactly the data action
 * `Microsoft.Discovery/workspaces/projects/operations/read`, on the bound
 * workspace only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetToolOperationsHttp}.
 *
 * ### Calling GetToolOperations
 * **Example:** GetToolOperations from a Function
 * ```typescript
 * // init
 * const workspace = yield* Azure.Discovery.Workspace("lab", { supercomputerIds: [supercomputer.supercomputerId] });
 * const getToolOperations = yield* Azure.Discovery.GetToolOperations(workspace);
 *
 * // runtime
 * const result = yield* getToolOperations({ projectName: "materials" });
 *
 * // layer
 * Effect.provide(Azure.Discovery.GetToolOperationsHttp)
 * ```
 *
 * @binding
 * @category Discovery
 */
export interface GetToolOperations extends Binding.Service<
  GetToolOperations,
  "Azure.Discovery.GetToolOperations",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: GetToolOperationsRequest,
    ) => Effect.Effect<discovery.PagedOperation, discovery.GetToolOperationsError, RuntimeContext>
  >
> {}

export const GetToolOperations = Binding.Service<GetToolOperations>(
  "Azure.Discovery.GetToolOperations",
);
