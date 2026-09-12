import * as railway from "@distilled.cloud/railway";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";

const isThrottled = (error: unknown): boolean =>
  error instanceof railway.TooManyRequests ||
  error instanceof railway.RailwayRateLimited;

/**
 * Railway-wide retry policy for every SDK call made by the providers.
 *
 * Preserve the SDK's transient classification and leave time for the
 * throttling window to refill, with a bounded retry budget.
 */
export const factory: railway.Retry.Factory = (lastError) => {
  const base = railway.Retry.makeDefault(lastError);
  return {
    while: base.while,
    schedule: Schedule.max([
      Schedule.exponential(500, 2).pipe(
        railway.Retry.capped(Duration.seconds(15)),
        Schedule.modifyDelay(({ duration }) =>
          Effect.gen(function* () {
            const error = yield* Ref.get(lastError);
            return isThrottled(error) &&
              Duration.isLessThan(duration, Duration.seconds(25))
              ? Duration.seconds(25)
              : duration;
          }),
        ),
        railway.Retry.jittered,
      ),
      Schedule.recurs(8),
    ]).pipe(Schedule.upTo({ duration: "45 seconds" })),
  };
};

/** Provide the Railway retry policy to every operation below. */
export const RailwayRetryPolicy: Layer.Layer<railway.Retry.Retry> =
  Layer.succeed(railway.Retry.Retry, factory);
