import type * as sql from "@distilled.cloud/azure/sql";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ElasticPool } from "./ElasticPool.ts";

export interface FailoverElasticPoolRequest extends Omit<
  sql.ElasticPoolsFailoverRequest,
  "subscriptionId" | "resourceGroupName" | "serverName" | "elasticPoolName"
> {}

/**
 * Fail every database of a SQL elastic pool over to another replica in its
 * region (`POST …/elasticPools/{pool}/failover`).
 *
 * Binding assigns a custom role (`AzureSqlFailoverElasticPoolRole`, one per
 * stack, shared by every host of this binding) with exactly the action
 * `Microsoft.Sql/servers/elasticPools/failover/action`, on the elastic pool
 * only. On a host with a managed identity (an Azure Function, Function App,
 * Web App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link FailoverElasticPoolHttp}.
 *
 * ### Calling FailoverElasticPool
 * **Example:** FailoverElasticPool from a Function
 * ```typescript
 * // init
 * const failoverElasticPool = yield* Azure.Sql.FailoverElasticPool(pool);
 *
 * // runtime
 * yield* failoverElasticPool();
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const failoverElasticPool = yield* Azure.Sql.FailoverElasticPool(pool);
 *   // ...
 * }).pipe(Effect.provide(Azure.Sql.FailoverElasticPoolHttp));
 * ```
 *
 * @binding
 * @category Sql
 */
export interface FailoverElasticPool extends Binding.Service<
  FailoverElasticPool,
  "Azure.Sql.FailoverElasticPool",
  (
    pool: ElasticPool,
  ) => Effect.Effect<
    (
      request?: FailoverElasticPoolRequest,
    ) => Effect.Effect<
      sql.ElasticPoolsFailoverResponse,
      sql.ElasticPoolsFailoverError,
      RuntimeContext
    >
  >
> {}

export const FailoverElasticPool = Binding.Service<FailoverElasticPool>(
  "Azure.Sql.FailoverElasticPool",
);
