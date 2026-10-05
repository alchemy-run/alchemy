import * as Cause from "effect/Cause";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Batch, ConsumedRecord, K2SchemaError } from "./K2Types.ts";
import type { ReadSubscriptionClient } from "./ReadSubscription.ts";

/**
 * The pull loop behind `consumeStreamRecords`. Internal — not exported from
 * the K2 barrel (tests import it directly).
 */

/** `consume` errors that mean "try again", not "give up". */
const RETRYABLE_CONSUME_ERRORS: ReadonlyArray<string> = [
  "K2Unavailable",
  "K2ReadFailed",
  "K2LeasesExhausted",
  "K2BatchPending",
];

/** Bounded backoff for retryable `consume` errors: ~30 s in total. */
const consumeRetry = Schedule.max([
  Schedule.min([Schedule.exponential("250 millis"), Schedule.spaced("5 seconds")]),
  Schedule.recurs(8),
]);

export interface PollOptions<A, Req> {
  client: ReadSubscriptionClient;
  /** Worker id holding the leases. Must be unique per concurrent poller. */
  workerId: string;
  /** @default 100 */
  maxRecords?: number;
  /** Sleep after an empty batch or a failed iteration. @default "1 second" */
  idleBackoff?: Duration.Input;
  /** Extend the five-minute lease this often while the handler runs. @default "2 minutes" */
  extendEvery?: Duration.Input;
  /** Turn consumed records into the handler's elements (e.g. schema decode). */
  decode: (
    records: ReadonlyArray<ConsumedRecord>,
  ) => Effect.Effect<ReadonlyArray<A>, K2SchemaError>;
  process: (records: Stream.Stream<A>) => Effect.Effect<void, unknown, Req>;
}

/**
 * Keep a batch's lease alive while its handler runs. Stops on `K2LeaseLost`
 * (the batch was acked, nacked, or redelivered elsewhere).
 */
const keepLeaseAlive = (client: ReadSubscriptionClient, batch: Batch, every: Duration.Input) =>
  Effect.sleep(every).pipe(
    Effect.andThen(client.extend(batch)),
    Effect.forever,
    Effect.catchTag("K2LeaseLost", () =>
      Effect.logWarning(`K2 lease lost for batch ${batch.batchId}; it may be redelivered`),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning(`K2 lease extension failed for batch ${batch.batchId}`, cause),
    ),
  );

/**
 * One poll: lease a batch, run the handler, then ack it on success or nack
 * it on failure. Returns whether a batch was processed.
 */
export const pollOnce = <A, Req>(
  options: PollOptions<A, Req>,
): Effect.Effect<boolean, unknown, Req | RuntimeContext> =>
  Effect.gen(function* () {
    const { client } = options;
    const leased = yield* client
      .consume({ workerId: options.workerId, maxRecords: options.maxRecords })
      .pipe(
        Effect.retry({
          while: (e) => RETRYABLE_CONSUME_ERRORS.includes(e._tag),
          schedule: consumeRetry,
        }),
      );
    if (Option.isNone(leased)) return false;
    const batch = leased.value;

    const outcome = yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.forkScoped(keepLeaseAlive(client, batch, options.extendEvery ?? "2 minutes"));
        return yield* Effect.exit(
          options
            .decode(batch.records)
            .pipe(Effect.flatMap((values) => options.process(Stream.fromIterable(values)))),
        );
      }),
    );

    if (Exit.isSuccess(outcome)) {
      yield* client.ack(batch);
    } else {
      yield* Effect.logWarning(
        `K2 handler failed for batch ${batch.batchId}; releasing it for redelivery`,
        Cause.pretty(outcome.cause),
      );
      yield* client.nack(batch);
    }
    return true;
  });

/**
 * Poll forever: an empty batch or a failed iteration sleeps `idleBackoff`;
 * a processed batch polls again immediately. Never fails.
 */
export const pollForever = <A, Req>(
  options: PollOptions<A, Req>,
): Effect.Effect<never, never, Req | RuntimeContext> =>
  pollOnce(options).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(`K2 poll failed for worker ${options.workerId}`, cause).pipe(
        Effect.as(false),
      ),
    ),
    Effect.flatMap((processed) =>
      processed ? Effect.void : Effect.sleep(options.idleBackoff ?? "1 second"),
    ),
    Effect.forever,
  );

/** Run `concurrency` pollers, each with its own worker id (`${workerId}-${i}`). */
export const pollSubscription = <A, Req>(
  options: PollOptions<A, Req> & { concurrency?: number },
): Effect.Effect<void, never, Req | RuntimeContext> =>
  Effect.forEach(
    Array.from({ length: Math.max(1, options.concurrency ?? 1) }, (_, i) => i),
    (i) => pollForever({ ...options, workerId: `${options.workerId}-${i}` }),
    { concurrency: "unbounded", discard: true },
  );
