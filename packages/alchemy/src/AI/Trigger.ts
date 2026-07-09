import type { EventSource } from "./EventSource.ts";
import type { Parameter } from "./Parameter.ts";

/**
 * A cron schedule, produced by `AI.every("1 week")` / `AI.every("0 0 * * 1")`.
 */
export interface Cron {
  "~alchemy/Kind": "Cron";
  expression: string;
}

/**
 * A control ref that wires a {@link Process}'s wake-up source — the loop-side
 * subscription to one or more world-side {@link EventSource}s (the topics),
 * a durable work queue, or a schedule.
 *
 * - `AI.on(...sources)` — wake on external events (webhook, bus event)
 * - `AI.each(param)` — consume a durable work queue of `param`-shaped items
 * - `AI.every("1 week")` — scheduled (cron / alarm)
 *
 * `each` and `on` unify as a `Stream<In>` at interpretation time; `each`
 * additionally implies a durable queue with acknowledgement semantics.
 *
 * The union of a charter's trigger inputs is the loop's `In` channel — the
 * work-item type a run is given, and the payload type of `dispatch`.
 *
 * Unlike `Halt` and `Fold`, a trigger is not a template tag and carries no
 * nested refs: the prose describing what to do with a work item lives in
 * the charter around the interpolation (`${AI.on(IssueOpened)} run
 * ${Triage}`), so its refs already flow through the charter itself.
 *
 * A trigger *does* contribute its sources' **channel tags** to the loop's
 * `Req` (`Channels`): subscribing to `Github.IssueOpened(repo)` is what
 * obligates the deployment to provide the `GitHubEvents` channel Layer —
 * whose own requirements (e.g. `GitHub.RepositoryEventSource` on
 * Cloudflare, the binding that provisions the webhook) are the second,
 * transitive compile fence. Declaring the subscription provisions the
 * wire — and forgetting either Layer is a compile error.
 */
export interface Trigger<In = unknown, Channels = never> {
  "~alchemy/Kind": "Trigger";
  /** Phantom carrier for the trigger's work-item type. */
  "~alchemy/In": In;
  /** Phantom carrier for the sources' channel tags. */
  "~alchemy/Channels": Channels;
  mode: "on" | "each" | "every";
  sources: ReadonlyArray<EventSource<any, any, any> | Parameter | Cron>;
}

/** Wake the loop on any of the given external events. */
export const on = <const Sources extends EventSource<any, any, any>[]>(
  ...sources: Sources
): Trigger<
  Sources[number] extends EventSource<infer In, any, any> ? In : never,
  Sources[number]["~alchemy/Channel"]
> => makeTrigger("on", sources);

/** Consume a durable work queue of `param`-shaped items. */
export const each = <P extends Parameter>(
  param: P,
): Trigger<P["schema"]["Type"], never> => makeTrigger("each", [param]);

/** Wake the loop on a schedule (cron expression or human-readable interval). */
export const every = (expression: string): Trigger<void, never> =>
  makeTrigger("every", [{ "~alchemy/Kind": "Cron", expression }]);

const makeTrigger = (
  mode: "on" | "each" | "every",
  sources: ReadonlyArray<EventSource<any, any, any> | Parameter | Cron>,
): any => ({
  "~alchemy/Kind": "Trigger",
  mode,
  sources,
});

/**
 * Narrows to the `Trigger` members of a ref union (generic for the same
 * variance reason as `isHalt`: a fixed `Trigger<any, any>` is not
 * assignable to a `never`-channel trigger).
 */
export const isTrigger = <T>(
  value: T,
): value is Extract<T, Trigger<any, any>> =>
  typeof value === "object" &&
  value !== null &&
  (value as Record<string, unknown>)["~alchemy/Kind"] === "Trigger";
