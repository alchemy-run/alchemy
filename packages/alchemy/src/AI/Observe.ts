import type { Agent } from "./Agent.ts";
import type { Process } from "./Process.ts";

/**
 * A control ref that references another term's *Trace* (its persisted event
 * log) without delegating to it.
 *
 * Interpolating `${Flywheel}` in a charter is delegation: the loop may
 * dispatch runs of Flywheel, so Flywheel's transitive requirements flow into
 * the loop's `Req`. Interpolating `${AI.observe(Flywheel)}` is observation:
 * the loop may *read* Flywheel's traces and events, but gains none of its
 * capabilities.
 *
 * This distinction is load-bearing for constitutional constraints: the
 * system loop (Autoresearch) studies the traces of the rings it improves —
 * `AI.observe(Flywheel)` — without inheriting Flywheel's `Approve`. If it
 * delegated instead, capability denial by omission would be destroyed by
 * transitivity.
 *
 * ```ts
 * Each week, study the traces of ${AI.observe(Flywheel)} and
 * ${AI.observe(Helpdesk)}: cluster failures; find prompts correlated
 * with reopened issues.
 * ```
 */
export interface Observe<
  T extends
    | Agent<any, any, any, any>
    | Process<any, any, any, any, any, any, any> =
    | Agent<any, any, any, any>
    | Process<any, any, any, any, any, any, any>,
> {
  "~alchemy/Kind": "Observe";
  subject: T;
}

/** Reference `subject`'s Trace read-only, without inheriting its `Req`. */
export const observe = <
  T extends
    | Agent<any, any, any, any>
    | Process<any, any, any, any, any, any, any>,
>(
  subject: T,
): Observe<T> => ({
  "~alchemy/Kind": "Observe",
  subject,
});

export const isObserve = (value: unknown): value is Observe<any> =>
  typeof value === "object" &&
  value !== null &&
  (value as Record<string, unknown>)["~alchemy/Kind"] === "Observe";
