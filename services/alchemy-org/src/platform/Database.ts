import * as D1 from "alchemy/Cloudflare/D1";
import { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import { provide } from "effect/Effect";

/**
 * The org's ONE D1 database — the book of record on Cloudflare: the
 * Ledger's delivery dedupe and the SessionIndex's board rows keep
 * their tables here (proposals live in Durable Objects partitioned by
 * pull request — `github/ProposalsDO.ts`). The resource IS the
 * export (memoized by FQN): every Layer that yields this const and
 * the Stack that provisions it resolve the same instance.
 */
export const database = D1.Database("org-db", {});

/**
 * Discharge the D1 client's `RuntimeContext` color. The client's
 * executors are typed "runs only inside the deployed Worker"; the
 * org's D1 layers are the one place that KNOWS their calls run inside
 * Worker/DO handlers — the color is phantom (nothing reads the
 * service; see `PreparedStatement.withRuntime`).
 */
export const inWorker = <A, E>(
  effect: Effect.Effect<A, E, RuntimeContext>,
): Effect.Effect<A, E> => provide(effect, RuntimeContext.phantom);
