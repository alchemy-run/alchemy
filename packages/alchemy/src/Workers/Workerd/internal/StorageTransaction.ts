import type * as cf from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import { ActiveStorageTransactions } from "../DurableObjectTransactionContext.ts";

/**
 * Runs scheduler bookkeeping inside the calling fiber's transaction on
 * `storage`, so a job scheduled in a transaction commits or rolls back with
 * it. Otherwise it runs through `start`, which opens a new transaction, or
 * fails when the caller holds a transaction it can no longer use.
 */
export const inStorageTransaction = <A, E, R, E2, R2>(
  storage: cf.DurableObjectStorage,
  effect: Effect.Effect<A, E, R>,
  start: (effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | E2, R | R2>,
): Effect.Effect<A, E | E2, R | R2> =>
  Effect.withFiber((fiber) => {
    const owned = fiber.getRef(ActiveStorageTransactions).get(storage);
    return owned !== undefined && owned.active && owned.owner === fiber && !owned.rolledBack
      ? effect
      : start(effect);
  });
