import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * The longest single sleep any exponential retry schedule may take.
 *
 * An uncapped `Schedule.exponential` doubles without bound — attempt 14 of a
 * 100ms base sleeps ~14 minutes, and `Schedule.max([exponential, recurs(N)])`
 * bounds ATTEMPTS, not DELAYS, so a non-convergent retry silently eats any
 * caller's budget (the Router destroy's 34-minute stall, 2026-08-15).
 */
export const MAX_RETRY_DELAY = Duration.seconds(30);

/**
 * `Schedule.exponential` with each delay clamped to {@link MAX_RETRY_DELAY}.
 *
 * Drop-in replacement: same `(base, factor?)` signature. Use this instead of
 * a bare `Schedule.exponential` in every retry/repeat — pipe a tighter
 * site-specific clamp on top where the API converges faster (see
 * `cappedKvsRetrySchedule` in AWS/CloudFront/common.ts).
 */
export const cappedExponential = (
  base: Duration.Input,
  factor?: number,
): Schedule.Schedule<Duration.Duration> =>
  Schedule.exponential(base, factor).pipe(
    Schedule.modifyDelay(({ duration }) =>
      Effect.succeed(
        Duration.isGreaterThan(duration, MAX_RETRY_DELAY)
          ? MAX_RETRY_DELAY
          : duration,
      ),
    ),
  );
