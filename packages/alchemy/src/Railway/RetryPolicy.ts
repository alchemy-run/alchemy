import * as railway from "@distilled.cloud/railway";
import * as Duration from "effect/Duration";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

/** Bound compatibility SDK retries; native GraphQL applies query-safe retries itself. */
export const factory: railway.Retry.Factory = (lastError) => {
  const base = railway.Retry.makeDefault(lastError);
  return {
    while: base.while,
    schedule: Schedule.max([
      Schedule.exponential(500, 2).pipe(
        railway.Retry.capped(Duration.seconds(5)),
        railway.Retry.jittered,
      ),
      Schedule.recurs(8),
    ]),
  };
};

/** Provide the bounded retry policy for compatibility SDK consumers. */
export const RailwayRetryPolicy: Layer.Layer<railway.Retry.Retry> =
  Layer.succeed(railway.Retry.Retry, factory);
