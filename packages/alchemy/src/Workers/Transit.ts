import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";

/**
 * The native error behind a failed Durable Object call: the `cause` of an
 * `RpcCallError` from an Effect-wrapped stub, or the failure itself.
 */
const nativeErrorOf = (error: unknown): unknown =>
  Predicate.isTagged(error, "RpcCallError") && Predicate.hasProperty(error, "cause")
    ? error.cause
    : error;

/**
 * Whether workerd marked a failed Durable Object call `overloaded`: the object
 * is refusing load, and Cloudflare deliberately does not retry it.
 */
export const isOverloaded = (error: unknown): boolean => {
  const native = nativeErrorOf(error);
  return Predicate.hasProperty(native, "overloaded") && native.overloaded === true;
};

/**
 * Whether a call that failed in transit may be sent again. Not when workerd
 * marked it `overloaded` (more calls add to the load Cloudflare is shedding)
 * or explicitly not `retryable`. Everything else is retried: an error marked
 * `retryable`, an instance resetting with an opaque "internal error", and an
 * instance still running the previous script during a deploy (which doesn't
 * implement the method being called).
 */
export const isTransitRetryable = (error: unknown): boolean => {
  const native = nativeErrorOf(error);
  if (isOverloaded(native)) return false;
  return !(Predicate.hasProperty(native, "retryable") && native.retryable === false);
};

/**
 * How long to keep retrying a Durable Object call that failed in transit.
 * Backs off from 100ms to 2s, about a minute in total, so a call survives a
 * deploy's rollout. Only errors {@link isTransitRetryable} accepts are retried.
 */
export const TRANSIT_RETRY = {
  while: isTransitRetryable,
  // Whichever delay is shorter: exponential at first, then every 2 seconds.
  schedule: Schedule.min([Schedule.exponential("100 millis"), Schedule.spaced("2 seconds")]),
  times: 35,
} as const;

/**
 * Retry an idempotent Durable Object call that failed in transit, under
 * {@link TRANSIT_RETRY}. An overloaded or non-retryable failure fails at once.
 */
export const retryInTransit = <A, E, R>(call: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.retry(call, TRANSIT_RETRY);
