import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";

export interface PollBudget {
  /** Longest pause between two observations. */
  readonly every: Duration.Input;
  /** Observations after the first one. */
  readonly times: number;
}

const backoffUpTo = (every: Duration.Input) =>
  Schedule.min([Schedule.exponential(Duration.millis(500), 1.5), Schedule.spaced(every)]);

/**
 * Observes until `until` holds and returns that observation. Fails with
 * `onTimeout(last)` when the budget runs out.
 */
export const pollUntil: {
  <A, B extends A, E, R, Timeout>(
    observe: Effect.Effect<A, E, R>,
    options: PollBudget & {
      readonly until: Predicate.Refinement<A, B>;
      readonly onTimeout: (last: A) => Timeout;
    },
  ): Effect.Effect<B, E | Timeout, R>;
  <A, E, R, Timeout>(
    observe: Effect.Effect<A, E, R>,
    options: PollBudget & {
      readonly until: Predicate.Predicate<A>;
      readonly onTimeout: (last: A) => Timeout;
    },
  ): Effect.Effect<A, E | Timeout, R>;
} = <A, E, R, Timeout>(
  observe: Effect.Effect<A, E, R>,
  options: PollBudget & {
    readonly until: Predicate.Predicate<A>;
    readonly onTimeout: (last: A) => Timeout;
  },
): Effect.Effect<A, E | Timeout, R> =>
  observe.pipe(
    Effect.repeat({
      schedule: backoffUpTo(options.every),
      until: options.until,
      times: options.times,
    }),
    Effect.filterOrFail(options.until, options.onTimeout),
  );
