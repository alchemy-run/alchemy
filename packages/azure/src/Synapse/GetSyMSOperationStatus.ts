import type * as syms from "@distilled.cloud/azure/synapse-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Workspace } from "./Workspace.ts";

/**
 * `GetSyMSOperationStatus` request without `endpoint`, which the bound
 * workspace (its development endpoint) supplies.
 */
export interface GetSyMSOperationStatusRequest extends Omit<
  syms.GetSyMSOperationStatusRequest,
  "endpoint"
> {}

/**
 * Read the status of a validated DDL change by operation ID.
 *
 * Binding assigns the Synapse RBAC role **Synapse Artifact User** to the host's
 * principal on the bound workspace only (an
 * `Azure.Synapse.WorkspaceRoleAssignment`): the smallest role SyMS accepts for
 * reads (**Synapse User** gets 403). Synapse RBAC has no custom roles. The
 * workspace firewall must admit the host (Flex Consumption and Workers use
 * shared outbound IPs).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetSyMSOperationStatusHttp}.
 *
 * ### Calling GetSyMSOperationStatus
 * **Example:** GetSyMSOperationStatus from a Function
 * ```typescript
 * // init
 * const workspace = yield* Azure.Synapse.Workspace("lake", { defaultDataLakeStorage, sqlAdministratorLogin, sqlAdministratorLoginPassword });
 * const getSyMSOperationStatus = yield* Azure.Synapse.GetSyMSOperationStatus(workspace);
 *
 * // runtime
 * const result = yield* getSyMSOperationStatus({ operationId });
 *
 * // layer
 * Effect.provide(Azure.Synapse.GetSyMSOperationStatusHttp)
 * ```
 *
 * @binding
 * @category Synapse
 */
export interface GetSyMSOperationStatus extends Binding.Service<
  GetSyMSOperationStatus,
  "Azure.Synapse.GetSyMSOperationStatus",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: GetSyMSOperationStatusRequest,
    ) => Effect.Effect<
      syms.QueryArtifactsResponse,
      syms.GetSyMSOperationStatusError,
      RuntimeContext
    >
  >
> {}

export const GetSyMSOperationStatus = Binding.Service<GetSyMSOperationStatus>(
  "Azure.Synapse.GetSyMSOperationStatus",
);
