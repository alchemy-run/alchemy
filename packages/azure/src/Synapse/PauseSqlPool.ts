import type * as synapse from "@distilled.cloud/azure/synapse";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { SqlPool } from "./SqlPool.ts";

export interface PauseSqlPoolRequest extends Omit<
  synapse.PauseSqlPoolRequest,
  "subscriptionId" | "resourceGroupName" | "workspaceName" | "sqlPoolName"
> {}

/**
 * Pause a Synapse dedicated SQL pool (`POST …/sqlPools/{pool}/pause`); compute
 * billing stops, storage billing continues.
 *
 * Binding assigns a custom role (`AzureSynapsePauseSqlPoolRole`, one per
 * stack, shared by every host of this binding) with exactly the action
 * `Microsoft.Synapse/workspaces/sqlPools/pause/action`, on the SQL pool only.
 * On a host with a managed identity (an Azure Function, Function App, Web App,
 * Container App, container group, VM, or AKS workload identity) the role goes
 * to that identity; any other host (a Cloudflare Worker, an AWS Lambda) gets
 * an Entra service principal (see `AzureBindings`).
 * Provide {@link PauseSqlPoolHttp}.
 *
 * ### Calling PauseSqlPool
 * **Example:** PauseSqlPool from a Function
 * ```typescript
 * // init
 * const pauseSqlPool = yield* Azure.Synapse.PauseSqlPool(pool);
 *
 * // runtime
 * yield* pauseSqlPool();
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const pauseSqlPool = yield* Azure.Synapse.PauseSqlPool(pool);
 *   // ...
 * }).pipe(Effect.provide(Azure.Synapse.PauseSqlPoolHttp));
 * ```
 *
 * @binding
 * @category Synapse
 */
export interface PauseSqlPool extends Binding.Service<
  PauseSqlPool,
  "Azure.Synapse.PauseSqlPool",
  (
    pool: SqlPool,
  ) => Effect.Effect<
    (
      request?: PauseSqlPoolRequest,
    ) => Effect.Effect<synapse.PauseSqlPoolResponse, synapse.PauseSqlPoolError, RuntimeContext>
  >
> {}

export const PauseSqlPool = Binding.Service<PauseSqlPool>("Azure.Synapse.PauseSqlPool");
