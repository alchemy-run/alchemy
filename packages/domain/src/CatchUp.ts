import type { Delivery } from "./Platform.ts";

/**
 * How a view or projection added after its sources recorded events receives
 * their history. Pure rules shared by every platform.
 *
 * Each source instance (an aggregate instance, or a view key that other
 * consumers read) records how far it has routed its events to each view and
 * projection: its `Routed` cursors. A consumer whose cursor is behind the
 * instance's version is lagging. Live deliveries skip it, and the instance
 * replays its stored events to it instead, in order, through the same outbox,
 * until it reaches the current version and rejoins live delivery. So every
 * consumer receives one source instance's events in order, as the live path
 * does, and replays never jump ahead of history.
 *
 * Platforms replay in rounds bounded by time: each round replays every
 * instance's events committed before `until`, so a consumer fed by many
 * instances sees their history roughly in the order it happened. Policies are
 * never caught up: they act on new events only.
 *
 * @internal
 */

/** The last `seq` a source instance routed to each consumer, by {@link targetId}. */
export type Routed = Readonly<Record<string, number>>;

/**
 * A consumer's id in {@link Routed}: `view:Name` or `projection:Name`, with
 * `#<generation>` once it has been rebuilt. A rebuilt consumer is a new one
 * to its sources, so they replay their history to it.
 */
export const targetId = (target: {
  readonly kind: string;
  readonly name: string;
  readonly generation?: number;
}): string => `${target.kind}:${target.name}${target.generation ? `#${target.generation}` : ""}`;

/**
 * Route a commit's deliveries: drop those to lagging consumers (they receive
 * the events by replay), and advance the cursors of the live ones from
 * `before` to `after`. An instance with no cursors yet predates catch-up; its
 * consumers are taken as caught up.
 */
export const routeLive = (
  targets: ReadonlyArray<string>,
  routed: Routed | undefined,
  before: number,
  after: number,
  deliveries: ReadonlyArray<Delivery>,
): { readonly deliveries: ReadonlyArray<Delivery>; readonly routed: Routed } => {
  const base: Routed = routed ?? Object.fromEntries(targets.map((target) => [target, before]));
  const live = (target: string) => (base[target] ?? 0) === before;
  const next: Record<string, number> = { ...base };
  for (const target of targets) if (live(target)) next[target] = after;
  return {
    deliveries: deliveries.filter(
      (delivery) => delivery.target.kind === "policy" || live(targetId(delivery.target)),
    ),
    routed: next,
  };
};

/**
 * The lowest cursor among consumers behind `version`: replay the instance's
 * rows after it. `undefined` when every consumer is caught up.
 */
export const laggingFrom = (
  targets: ReadonlyArray<string>,
  routed: Routed | undefined,
  version: number,
): number | undefined => {
  if (routed === undefined) return undefined;
  let from: number | undefined;
  for (const target of targets) {
    const cursor = routed[target] ?? 0;
    if (cursor < version) from = from === undefined ? cursor : Math.min(from, cursor);
  }
  return from;
};

/** What a replay needs: stored rows after {@link laggingFrom}, in order. */
export interface ReplayInput<Row> {
  /** The instance: an aggregate id, or a view key. */
  readonly id: string;
  readonly routed: Routed;
  readonly rows: ReadonlyArray<Row>;
  /** Replay only rows committed before this time, in epoch milliseconds. */
  readonly until: number;
}

/** What a replay produced. */
export interface ReplayResult {
  /** Deliveries to lagging consumers, marked `history`. */
  readonly deliveries: ReadonlyArray<Delivery>;
  readonly routed: Routed;
  /** When the first row left unreplayed was committed, if a row was left. */
  readonly next: number | undefined;
}

/** The earlier of two optional times. */
export const earliest = (a: number | undefined, b: number | undefined): number | undefined =>
  a === undefined ? b : b === undefined ? a : Math.min(a, b);
