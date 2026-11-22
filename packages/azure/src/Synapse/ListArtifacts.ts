import type * as syms from "@distilled.cloud/azure/synapse-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Workspace } from "./Workspace.ts";

/**
 * `ListArtifacts` request without `endpoint`, which the bound workspace (its
 * development endpoint) supplies.
 */
export interface ListArtifactsRequest extends Omit<syms.ListArtifactsRequest, "endpoint"> {}

/**
 * List the artifacts of one type (tables, views, ...) in a lake database.
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
 * Provide {@link ListArtifactsHttp}.
 *
 * ### Calling ListArtifacts
 * **Example:** ListArtifacts from a Function
 * ```typescript
 * // init
 * const workspace = yield* Azure.Synapse.Workspace("lake", { defaultDataLakeStorage, sqlAdministratorLogin, sqlAdministratorLoginPassword });
 * const listArtifacts = yield* Azure.Synapse.ListArtifacts(workspace);
 *
 * // runtime
 * const result = yield* listArtifacts({ databaseName: "sales", artifactType: "TABLE" });
 *
 * // layer
 * Effect.provide(Azure.Synapse.ListArtifactsHttp)
 * ```
 *
 * @binding
 * @category Synapse
 */
export interface ListArtifacts extends Binding.Service<
  ListArtifacts,
  "Azure.Synapse.ListArtifacts",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: ListArtifactsRequest,
    ) => Effect.Effect<syms.QueryArtifactsResponse, syms.ListArtifactsError, RuntimeContext>
  >
> {}

export const ListArtifacts = Binding.Service<ListArtifacts>("Azure.Synapse.ListArtifacts");
