import type * as synapse from "@distilled.cloud/azure/synapse";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { SqlPool } from "./SqlPool.ts";

export interface ResumeSqlPoolRequest extends Omit<
  synapse.ResumeSqlPoolRequest,
  "subscriptionId" | "resourceGroupName" | "workspaceName" | "sqlPoolName"
> {}

/**
 * Resume a paused Synapse dedicated SQL pool (`POST
 * …/sqlPools/{pool}/resume`).
 *
 * Binding assigns a custom role (`AzureSynapseResumeSqlPoolRole`, one per
 * stack, shared by every host of this binding) with exactly the action
 * `Microsoft.Synapse/workspaces/sqlPools/resume/action`, on the SQL pool only.
 * On a host with a managed identity (an Azure Function, Function App, Web App,
 * Container App, container group, VM, or AKS workload identity) the role goes
 * to that identity; any other host (a Cloudflare Worker, an AWS Lambda) gets
 * an Entra service principal (see `AzureBindings`).
 * Provide {@link ResumeSqlPoolHttp}.
 *
 * ### Calling ResumeSqlPool
 * **Example:** ResumeSqlPool from a Function
 * ```typescript
 * // init
 * const resumeSqlPool = yield* Azure.Synapse.ResumeSqlPool(pool);
 *
 * // runtime
 * yield* resumeSqlPool();
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const resumeSqlPool = yield* Azure.Synapse.ResumeSqlPool(pool);
 *   // ...
 * }).pipe(Effect.provide(Azure.Synapse.ResumeSqlPoolHttp));
 * ```
 *
 * @binding
 * @category Synapse
 */
export interface ResumeSqlPool extends Binding.Service<
  ResumeSqlPool,
  "Azure.Synapse.ResumeSqlPool",
  (
    pool: SqlPool,
  ) => Effect.Effect<
    (
      request?: ResumeSqlPoolRequest,
    ) => Effect.Effect<synapse.ResumeSqlPoolResponse, synapse.ResumeSqlPoolError, RuntimeContext>
  >
> {}

export const ResumeSqlPool = Binding.Service<ResumeSqlPool>("Azure.Synapse.ResumeSqlPool");
