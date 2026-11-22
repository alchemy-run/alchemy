import type * as batch from "@distilled.cloud/azure/batch";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Pool } from "./Pool.ts";

export interface StopPoolResizeRequest extends Omit<
  batch.PoolStopResizeRequest,
  "subscriptionId" | "resourceGroupName" | "accountName" | "poolName"
> {}

/**
 * Stop an ongoing resize of a Batch pool (`POST …/pools/{poolName}/stopResize`), leaving the nodes it has, from any host.
 *
 * Binding assigns a custom role (`AzureBatchStopPoolResizeRole`, one per stack, with
 * exactly the action `Microsoft.Batch/batchAccounts/pools/stopResize/action`) on the pool only.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link StopPoolResizeHttp}.
 *
 * ### Calling StopPoolResize
 * **Example:** StopPoolResize from a Function
 * ```typescript
 * // init
 * const stopPoolResize = yield* Azure.Batch.StopPoolResize(pool);
 *
 * // runtime
 * yield* stopPoolResize();
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const stopPoolResize = yield* Azure.Batch.StopPoolResize(pool);
 *   // ...
 * }).pipe(Effect.provide(Azure.Batch.StopPoolResizeHttp));
 * ```
 *
 * @binding
 * @category Batch
 */
export interface StopPoolResize extends Binding.Service<
  StopPoolResize,
  "Azure.Batch.StopPoolResize",
  (
    pool: Pool,
  ) => Effect.Effect<
    (
      request?: StopPoolResizeRequest,
    ) => Effect.Effect<batch.PoolStopResizeResponse, batch.PoolStopResizeError, RuntimeContext>
  >
> {}

export const StopPoolResize = Binding.Service<StopPoolResize>("Azure.Batch.StopPoolResize");
