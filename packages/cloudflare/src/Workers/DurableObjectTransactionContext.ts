import type * as cf from "@cloudflare/workers-types";
import * as Context from "effect/Context";
import type * as Fiber from "effect/Fiber";

/**
 * Alarm scheduler bookkeeping, shared by a transaction and the transactions
 * nested in it. The native alarm is reconciled once, before the outermost
 * transaction commits.
 */
export interface AlarmBatch {
  tablesEnsured: boolean;
  dirty: boolean;
}

export interface ActiveStorageTransaction {
  readonly transaction: cf.DurableObjectTransaction;
  readonly alarms: AlarmBatch;
  owner: Fiber.Fiber<unknown, unknown> | undefined;
  active: boolean;
  rolledBack: boolean;
  /** Resolves once the native transaction commits or rolls back. */
  readonly settled: Promise<void>;
}

export const ActiveStorageTransactions = Context.Reference<
  ReadonlyMap<cf.DurableObjectStorage, ActiveStorageTransaction>
>("alchemy/Cloudflare/ActiveStorageTransactions", {
  defaultValue: () => new Map(),
});
