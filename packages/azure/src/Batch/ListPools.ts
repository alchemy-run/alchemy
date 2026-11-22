import type * as batch from "@distilled.cloud/azure/batch-data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface ListPoolsRequest extends Omit<batch.ListPoolPoolsRequest, "endpoint"> {}

/**
 * List the pools of an Azure Batch account (`GET /pools`, one page per call; pass the returned `odata_nextLink` as `nextLink` for the next page) from any host.
 *
 * Binding assigns a custom role (`AzureBatchReadPoolsRole` with exactly the action `Microsoft.Batch/batchAccounts/pools/read`, one per stack, shared with the other bindings that need it)
 * on the Batch account only. The account must allow Entra ID
 * authentication (`allowedAuthenticationModes` includes `AAD`, the
 * default). On a host with a managed identity (an Azure Function, Function
 * App, Web App, Container App, container group, VM, or AKS workload
 * identity) the role goes to that identity; any other host (a Cloudflare
 * Worker, an AWS Lambda) gets an Entra service principal (see
 * `AzureBindings`).
 * Provide {@link ListPoolsHttp}.
 *
 * ### Calling ListPools
 * **Example:** ListPools from a Function
 * ```typescript
 * // init
 * const listPools = yield* Azure.Batch.ListPools(account);
 *
 * // runtime
 * const page = yield* listPools();
 * const ids = page.value.map((pool) => pool.id);
 * ```
 *
 * **Example:** Provide the implementation on the Function
 * ```typescript
 * Effect.gen(function* () {
 *   const listPools = yield* Azure.Batch.ListPools(account);
 *   // ...
 * }).pipe(Effect.provide(Azure.Batch.ListPoolsHttp));
 * ```
 *
 * @binding
 * @category Batch
 */
export interface ListPools extends Binding.Service<
  ListPools,
  "Azure.Batch.ListPools",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request?: ListPoolsRequest,
    ) => Effect.Effect<batch.BatchPoolListResult, batch.ListPoolPoolsError, RuntimeContext>
  >
> {}

export const ListPools = Binding.Service<ListPools>("Azure.Batch.ListPools");
