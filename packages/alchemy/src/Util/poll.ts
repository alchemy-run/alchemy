import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
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
          input.schedule ??
          Schedule.max([Schedule.spaced("5 seconds"), Schedule.recurs(50)]),
      }),
    ),
);

export interface PollOptions {
  readonly every: Duration.Input;
  readonly times: number;
}

/**
 * Polls `observe` until `settled` holds. Fails with `notSettled(last)` when
 * the tries run out. `last` is the last observed value.
 */
export const pollUntil = <A, E, E2>(
  observe: Effect.Effect<Option.Option<A>, E>,
  settled: (value: A) => boolean,
  options: PollOptions & {
    readonly notSettled: (last: Option.Option<A>) => E2;
  },
): Effect.Effect<A, E | E2> =>
  observe.pipe(
    Effect.repeat({
      schedule: Schedule.spaced(options.every),
      until: (value) => Option.exists(value, settled),
      times: options.times,
    }),
    Effect.flatMap((last) =>
      Option.match(last, {
        onNone: () => Effect.fail(options.notSettled(last)),
        onSome: (value) =>
          settled(value)
            ? Effect.succeed(value)
            : Effect.fail(options.notSettled(last)),
      }),
    ),
  );

/** Polls `observe` until it sees nothing. Fails with `stillPresent()` when the tries run out. */
export const pollUntilGone = <A, E, E2>(
  observe: Effect.Effect<Option.Option<A>, E>,
  options: PollOptions & { readonly stillPresent: () => E2 },
): Effect.Effect<void, E | E2> =>
  observe.pipe(
    Effect.repeat({
      schedule: Schedule.spaced(options.every),
      until: Option.isNone,
      times: options.times,
    }),
    Effect.flatMap((last) =>
      Option.isNone(last) ? Effect.void : Effect.fail(options.stillPresent()),
    ),
  );
