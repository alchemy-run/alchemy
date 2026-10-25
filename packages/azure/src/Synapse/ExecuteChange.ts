import type * as syms from "@distilled.cloud/azure/synapse-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Workspace } from "./Workspace.ts";

/**
 * `ExecuteChange` request without `endpoint`, which the bound workspace (its
 * development endpoint) supplies.
 */
export interface ExecuteChangeRequest extends Omit<syms.ExecuteChangeRequest, "endpoint"> {}

/**
 * Run a batch of lake database DDL changes (`POST /databases/ExecuteChange`).
 *
 * Binding assigns the Synapse RBAC role **Synapse Artifact Publisher** to the
 * host's principal on the bound workspace only (an
 * `Azure.Synapse.WorkspaceRoleAssignment`): the smallest role SyMS accepts for
 * writes (**Synapse Artifact User** and **Synapse SQL Administrator** get 403).
 * Synapse RBAC has no custom roles. The workspace firewall must admit the host
 * (Flex Consumption and Workers use shared outbound IPs).
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link ExecuteChangeHttp}.
 *
 * ### Calling ExecuteChange
 * **Example:** ExecuteChange from a Function
 * ```typescript
 * // init
 * const workspace = yield* Azure.Synapse.Workspace("lake", { defaultDataLakeStorage, sqlAdministratorLogin, sqlAdministratorLoginPassword });
 * const executeChange = yield* Azure.Synapse.ExecuteChange(workspace);
 *
 * // runtime
 * const result = yield* executeChange({ ddls: [{ actionType: "CREATE", newEntity: { name: "sales", type: "DATABASE", properties } }] });
 *
 * // layer
 * Effect.provide(Azure.Synapse.ExecuteChangeHttp)
 * ```
 *
 * @binding
 * @category Synapse
 */
export interface ExecuteChange extends Binding.Service<
  ExecuteChange,
  "Azure.Synapse.ExecuteChange",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: ExecuteChangeRequest,
    ) => Effect.Effect<syms.SyMSAPIDDLResponses, syms.ExecuteChangeError, RuntimeContext>
  >
> {}

export const ExecuteChange = Binding.Service<ExecuteChange>("Azure.Synapse.ExecuteChange");
