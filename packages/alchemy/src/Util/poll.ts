import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";

export class PredicateFailed extends Data.TaggedError("PredicateFailed")<{
  message: string;
  actual: unknown;
}> {}

export const isPredicateFailed = (e: unknown): e is PredicateFailed =>
  Predicate.isTagged(e, "PredicateFailed");

/**
 * Retries an effect until a predicate is met.
 * @param input - The input to the poll function.
 * @param input.description - The description of what is being polled; used in the error message if the predicate fails.
 * @param input.effect - The effect to execute until the predicate is met.
 * @param input.predicate - The predicate to check if the effect has met the desired state.
 * @param input.schedule - The schedule to use for retries; defaults to every 3 seconds.
 * @param input.times - The maximum number of times to poll; defaults to 50.
 * @returns The value that satisfies the predicate.
 */
export const poll = Effect.fn("poll")(
  <A, E, R>(input: {
    description?: string;
    effect: Effect.Effect<A, E, R>;
    predicate: (value: A) => boolean;
    schedule?: Schedule.Schedule<unknown, unknown, never>;
  }) =>
    input.effect.pipe(
      Effect.filterOrFail(
        input.predicate,
        (actual) =>
          new PredicateFailed({
            message: `Predicate failed: ${input.description ?? "<no description>"}`,
            actual,
          }),
      ),
      Effect.retry({
        while: isPredicateFailed,
        schedule:
          input.schedule ?? Schedule.max([Schedule.spaced("5 seconds"), Schedule.recurs(50)]),
      }),
    ),
);

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
