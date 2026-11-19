import type * as cf from "@cloudflare/workers-types";
import * as Context from "effect/Context";
import type * as Fiber from "effect/Fiber";

export interface ActiveStorageTransaction {
  readonly transaction: cf.DurableObjectTransaction;
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
