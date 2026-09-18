import type { RuntimeContext } from "alchemy";
import type * as TypeSafe from "alchemy/TypeSafe";
import * as Effect from "effect/Effect";

/**
 * SWARM — the shared floor under the walkers (Burst, Cluster, Looks).
 *
 * A walker is an ad-hoc Effect function that walks the post graph,
 * asks TypeSafe typed questions at each step, and dispatches agents at
 * the leaves. There is deliberately NO engine here — Effect is the
 * flow language (forEach is the fork, yield* is the series, the code
 * after a fork is the join). This module holds only what every walker
 * repeated: the deps contract and the failure-safe query.
 *
 * The rubrics do NOT live here. Each walker owns its questions —
 * extraction happens on repetition, and no question has repeated yet.
 */

/** One inbound thing a burst is made of. */
export interface InboundEvent {
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly kind: "pull" | "issue";
}

export type Agent = "head" | "manager" | "engineer" | "reviewer";

/** What a walker needs from the world — narrow, test-stubbable. */
export interface SwarmDeps {
  readonly query: typeof TypeSafe.SystemOne.Service;
  readonly post: (input: {
    readonly replyTo?: string;
    readonly author?: string;
    readonly text: string;
    readonly mode?: "thread" | "inline";
  }) => Effect.Effect<string, never, RuntimeContext>;
  /** Dispatch one agent into a thread; answers the agent's reply text. */
  readonly dispatch: (
    agent: Agent,
    input: { readonly thread: string; readonly ask: string },
  ) => Effect.Effect<string, never, RuntimeContext>;
  readonly budget: { readonly maxDispatches: number };
}

/**
 * A judgment that can only add signal: any failure becomes
 * `undefined`, and the caller's confidence gate treats that as
 * "unsure" — the walk degrades, never breaks.
 */
export const tryQuery = <A, E, R>(
  asked: Effect.Effect<A, E, R>,
): Effect.Effect<A | undefined, never, R> =>
  Effect.catchCause(asked, () => Effect.succeed(undefined));
