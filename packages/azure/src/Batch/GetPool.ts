import type * as batch from "@distilled.cloud/azure/batch-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface GetPoolRequest extends Omit<batch.GetPoolPoolRequest, "endpoint"> {}

/**
 * Read a pool's data-plane state (`GET /pools/{poolId}`): node counts, allocation state, resize errors from any host.
 *
 * Binding assigns a custom role (`AzureBatchReadPoolsRole` with exactly the action `Microsoft.Batch/batchAccounts/pools/read`, one per stack, shared with the other bindings that need it)
 * on the Batch account only. The account must allow Entra ID
 * authentication (`allowedAuthenticationModes` includes `AAD`, the
 * default). On a host with a managed identity (an Azure Function, Function
 * App, Web App, Container App, container group, VM, or AKS workload
 * identity) the role goes to that identity; any other host (a Cloudflare
 * Worker, an AWS Lambda) gets an Entra service principal (see
 * `AzureBindings`).
 * Provide {@link GetPoolHttp}.
 *
 * ### Calling GetPool
 * **Example:** GetPool from a Function
 * ```typescript
 * // init
 * const getPool = yield* Azure.Batch.GetPool(account);
 *
 * // runtime
 * const observed = yield* getPool({ poolId: pool.poolName });
 * const nodes = observed.currentDedicatedNodes;
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const getPool = yield* Azure.Batch.GetPool(account);
 *   // ...
 * }).pipe(Effect.provide(Azure.Batch.GetPoolHttp));
 * ```
 *
 * @binding
 * @category Batch
 */
export interface GetPool extends Binding.Service<
  GetPool,
  "Azure.Batch.GetPool",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: GetPoolRequest,
    ) => Effect.Effect<batch.GetPoolPoolResponse, batch.GetPoolPoolError, RuntimeContext>
  >
> {}

export const GetPool = Binding.Service<GetPool>("Azure.Batch.GetPool");
