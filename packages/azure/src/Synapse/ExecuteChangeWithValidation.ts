import type * as syms from "@distilled.cloud/azure/synapse-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Workspace } from "./Workspace.ts";

/**
 * `ExecuteChangeWithValidation` request without `endpoint`, which the bound
 * workspace (its development endpoint) supplies.
 */
export interface ExecuteChangeWithValidationRequest extends Omit<
  syms.ExecuteChangeWithValidationRequest,
  "endpoint"
> {}

/**
 * Run a batch of lake database DDL changes after validating them.
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
 * Provide {@link ExecuteChangeWithValidationHttp}.
 *
 * ### Calling ExecuteChangeWithValidation
 * **Example:** ExecuteChangeWithValidation from a Function
 * ```typescript
 * // init
 * const workspace = yield* Azure.Synapse.Workspace("lake", { defaultDataLakeStorage, sqlAdministratorLogin, sqlAdministratorLoginPassword });
 * const executeChangeWithValidation = yield* Azure.Synapse.ExecuteChangeWithValidation(workspace);
 *
 * // runtime
 * const result = yield* executeChangeWithValidation({ validationType: "IDWValidation", ddls });
 *
 * // layer
 * Effect.provide(Azure.Synapse.ExecuteChangeWithValidationHttp)
 * ```
 *
 * @binding
 * @category Synapse
 */
export interface ExecuteChangeWithValidation extends Binding.Service<
  ExecuteChangeWithValidation,
  "Azure.Synapse.ExecuteChangeWithValidation",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: ExecuteChangeWithValidationRequest,
    ) => Effect.Effect<
      syms.ExecuteChangeWithValidationResponse,
      syms.ExecuteChangeWithValidationError,
      RuntimeContext
    >
  >
> {}

export const ExecuteChangeWithValidation = Binding.Service<ExecuteChangeWithValidation>(
  "Azure.Synapse.ExecuteChangeWithValidation",
);
