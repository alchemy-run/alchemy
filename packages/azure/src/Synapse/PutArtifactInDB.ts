import type * as syms from "@distilled.cloud/azure/synapse-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Workspace } from "./Workspace.ts";

/**
 * `PutArtifactInDB` request without `endpoint`, which the bound workspace (its
 * development endpoint) supplies.
 */
export interface PutArtifactInDBRequest extends Omit<syms.PutArtifactInDBRequest, "endpoint"> {}

/**
 * Create or update an artifact (table, view, ...) in a lake database.
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
 * Provide {@link PutArtifactInDBHttp}.
 *
 * ### Calling PutArtifactInDB
 * **Example:** PutArtifactInDB from a Function
 * ```typescript
 * // init
 * const workspace = yield* Azure.Synapse.Workspace("lake", { defaultDataLakeStorage, sqlAdministratorLogin, sqlAdministratorLoginPassword });
 * const putArtifactInDB = yield* Azure.Synapse.PutArtifactInDB(workspace);
 *
 * // runtime
 * const result = yield* putArtifactInDB({ databaseName: "sales", artifactType: "TABLE", artifactName: "orders", name: "orders", type: "TABLE", properties });
 *
 * // layer
 * Effect.provide(Azure.Synapse.PutArtifactInDBHttp)
 * ```
 *
 * @binding
 * @category Synapse
 */
export interface PutArtifactInDB extends Binding.Service<
  PutArtifactInDB,
  "Azure.Synapse.PutArtifactInDB",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: PutArtifactInDBRequest,
    ) => Effect.Effect<syms.SyMSAPIDDLResponse, syms.PutArtifactInDBError, RuntimeContext>
  >
> {}

export const PutArtifactInDB = Binding.Service<PutArtifactInDB>("Azure.Synapse.PutArtifactInDB");
