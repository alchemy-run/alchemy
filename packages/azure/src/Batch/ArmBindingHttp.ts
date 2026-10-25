import type * as Effect from "effect/Effect";
import {
  type ArmActionGrant,
  type ArmActionRole,
  groupOf,
  makeArmActionBinding,
} from "../ArmActionBinding.ts";
import type { Account } from "./Account.ts";
import type { Pool } from "./Pool.ts";

/**
 * Shared scaffolding for the Batch ARM runtime-action bindings (the
 * `batch` management API, not the `batch-data` data plane in
 * `BindingHttp.ts`): the bound account or pool supplies its identifiers,
 * and each binding assigns its custom role on that resource only.
 *
 * NOT exported from `index.ts`.
 */

/** Batch management permissions the bindings grant (Azure RBAC actions). */
export const BatchArmPermission = {
  syncAutoStorageKeys: "Microsoft.Batch/batchAccounts/syncAutoStorageKeys/action",
  stopPoolResize: "Microsoft.Batch/batchAccounts/pools/stopResize/action",
  readStorageAccount: "Microsoft.Storage/storageAccounts/read",
  listStorageAccountKeys: "Microsoft.Storage/storageAccounts/listkeys/action",
} as const;

/**
 * Custom role per binding; the logical ID is `Azure<role>Role`. Built-in
 * roles with these actions (e.g. **Contributor**) also edit the account.
 */
export const BatchArmRole = {
  SynchronizeAutoStorageKeys: {
    role: "BatchSynchronizeAutoStorageKeys",
    actions: [BatchArmPermission.syncAutoStorageKeys],
  },
  StopPoolResize: { role: "BatchStopPoolResize", actions: [BatchArmPermission.stopPoolResize] },
  // Batch reads the auto-storage account's keys with the caller's token:
  // without these the sync answers `Conflict: The specified storage account
  // could not be found.`
  ReadAutoStorageKeys: {
    role: "BatchReadAutoStorageKeys",
    actions: [BatchArmPermission.readStorageAccount, BatchArmPermission.listStorageAccountKeys],
  },
} as const satisfies Record<string, ArmActionRole>;

/**
 * Build the impl Effect for a Batch account action: the runtime callable
 * fills the account's identifiers, and the deploy-time half assigns `role`
 * on the account.
 */
export const makeBatchAccountActionBinding = <
  I extends { subscriptionId: string; resourceGroupName: string; accountName: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.Batch.SynchronizeAutoStorageKeys`. */
  tag: string;
  /** The distilled `batch` operation. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, any>;
  /** The custom role assigned on the account. */
  role: ArmActionRole;
  /** Further roles on other resources. */
  also?: (account: Account) => readonly ArmActionGrant[];
}) =>
  makeArmActionBinding({
    ...options,
    scope: (account: Account) => account.accountId,
    target: (account) => account.accountId,
    input: (
      request: Omit<I, "subscriptionId" | "resourceGroupName" | "accountName"> | undefined,
      id,
    ) => ({ ...request, ...groupOf(id), accountName: id.names.batchaccounts ?? "" }) as I,
  });

/**
 * Build the impl Effect for a pool action: the runtime callable fills the
 * pool's identifiers, and the deploy-time half assigns `role` on the pool.
 */
export const makeBatchPoolActionBinding = <
  I extends {
    subscriptionId: string;
    resourceGroupName: string;
    accountName: string;
    poolName: string;
  },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.Batch.StopPoolResize`. */
  tag: string;
  /** The distilled `batch` operation. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, any>;
  /** The custom role assigned on the pool. */
  role: ArmActionRole;
}) =>
  makeArmActionBinding({
    ...options,
    scope: (pool: Pool) => pool.poolId,
    target: (pool) => pool.poolId,
    input: (
      request:
        | Omit<I, "subscriptionId" | "resourceGroupName" | "accountName" | "poolName">
        | undefined,
      id,
    ) =>
      ({
        ...request,
        ...groupOf(id),
        accountName: id.names.batchaccounts ?? "",
        poolName: id.names.pools ?? "",
      }) as I,
  });
