import type * as syms from "@distilled.cloud/azure/synapse-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Workspace } from "./Workspace.ts";

/**
 * `GetArtifactFromDB` request without `endpoint`, which the bound workspace
 * (its development endpoint) supplies.
 */
export interface GetArtifactFromDBRequest extends Omit<syms.GetArtifactFromDBRequest, "endpoint"> {}

/**
 * Read an artifact (table, view, ...) of a lake database.
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
 * Provide {@link GetArtifactFromDBHttp}.
 *
 * ### Calling GetArtifactFromDB
 * **Example:** GetArtifactFromDB from a Function
 * ```typescript
 * // init
 * const workspace = yield* Azure.Synapse.Workspace("lake", { defaultDataLakeStorage, sqlAdministratorLogin, sqlAdministratorLoginPassword });
 * const getArtifactFromDB = yield* Azure.Synapse.GetArtifactFromDB(workspace);
 *
 * // runtime
 * const result = yield* getArtifactFromDB({ databaseName: "sales", artifactType: "TABLE", artifactName: "orders" });
 *
 * // layer
 * Effect.provide(Azure.Synapse.GetArtifactFromDBHttp)
 * ```
 *
 * @binding
 * @category Synapse
 */
export interface GetArtifactFromDB extends Binding.Service<
  GetArtifactFromDB,
  "Azure.Synapse.GetArtifactFromDB",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: GetArtifactFromDBRequest,
    ) => Effect.Effect<syms.MDEntity, syms.GetArtifactFromDBError, RuntimeContext>
  >
> {}

export const GetArtifactFromDB = Binding.Service<GetArtifactFromDB>(
  "Azure.Synapse.GetArtifactFromDB",
);
