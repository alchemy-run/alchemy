import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

export interface PollOptions {
  readonly every: Duration.Input;
  readonly times: number;
  readonly timeout: Duration.Input;
}

/**
 * Polls `get` until `settled` holds. Fails with `notSettled(last)` when
 * the tries or the timeout run out. `last` is the last observed value.
 */
export const pollUntil = <A, E, E2>(
  get: Effect.Effect<Option.Option<A>, E>,
  settled: (value: A) => boolean,
  options: PollOptions & {
    readonly notSettled: (last: Option.Option<A>) => E2;
  },
): Effect.Effect<A, E | E2> =>
  get.pipe(
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
    Effect.timeoutOrElse({
      duration: options.timeout,
      orElse: () => Effect.fail(options.notSettled(Option.none())),
    }),
  );

/** Polls `get` until it observes nothing. Fails with `stillPresent()` otherwise. */
export const pollUntilGone = <A, E, E2>(
  get: Effect.Effect<Option.Option<A>, E>,
  options: PollOptions & { readonly stillPresent: () => E2 },
): Effect.Effect<void, E | E2> =>
  get.pipe(
    Effect.repeat({
      schedule: Schedule.spaced(options.every),
      until: Option.isNone,
      times: options.times,
    }),
    Effect.flatMap((last) =>
      Option.isNone(last) ? Effect.void : Effect.fail(options.stillPresent()),
    ),
    Effect.timeoutOrElse({
      duration: options.timeout,
      orElse: () => Effect.fail(options.stillPresent()),
    }),
  );
