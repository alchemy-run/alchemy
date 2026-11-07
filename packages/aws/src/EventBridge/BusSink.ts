import type * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import { type BatchRetryExhaustedError, makeBatchedSink } from "alchemy/Util/BatchedSink";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Sink from "effect/Sink";
import * as AWSBindings from "../AWSBindings.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { EventBus } from "./EventBus.ts";
import { PutEvents } from "./PutEvents.ts";

/**
 * A raw `PutEventsRequestEntry` minus `EventBusName`, which the sink derives
 * from the bus it is bound to. Callers stay in control of `Source`,
 * `DetailType`, `Detail`, `Time`, `Resources`, and `TraceHeader` — no
 * auto-marshalling.
 */
export interface BusSinkEntry extends Omit<eventbridge.PutEventsRequestEntry, "EventBusName"> {}

export type BusSinkError = eventbridge.PutEventsError | BatchRetryExhaustedError<BusSinkEntry>;

/**
 * A batching sink over EventBridge `PutEvents` (10 entries / 256 KiB per
 * call). Per-entry failures with transient error codes (`ThrottlingException`,
 * `InternalFailure`) are re-submitted on a bounded schedule; any other
 * per-entry `ErrorCode` (e.g. `MalformedDetail`) is permanent — those entries
 * are dropped and surfaced via a logged warning. Exhausting retries fails the
 * sink with a typed `BatchRetryExhaustedError` carrying the stranded entries.
 *
 * Omit the bus argument to publish to the account's default event bus.
 *
 * ### Streaming Events
 * **Example:** Run a Stream of Entries into the Bus
 * ```typescript
 * // init — bind the sink (provide AWS.EventBridge.BusSinkHttp on the Function)
 * const sink = yield* AWS.EventBridge.BusSink(bus);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime — publish a stream of raw PutEvents entries
 *     const entries: AWS.EventBridge.BusSinkEntry[] = markers.map((marker) => ({
 *       Source: "my.app",
 *       DetailType: "MarkerSeen",
 *       Detail: JSON.stringify({ marker }),
 *     }));
 *     yield* Stream.fromIterable(entries).pipe(Stream.run(sink));
 *     return HttpServerResponse.json({ ok: true });
 *   }),
 * };
 * ```
 *
 * @binding
 */
export interface BusSink extends Binding.Service<
  BusSink,
  "AWS.EventBridge.BusSink",
  (
    bus?: EventBus,
  ) => Effect.Effect<Sink.Sink<void, BusSinkEntry, readonly BusSinkEntry[], BusSinkError>>
> {}

export const BusSink = Binding.Service<BusSink>("AWS.EventBridge.BusSink");

const encoder = new TextEncoder();

/**
 * Approximate wire size of one entry, per AWS's documented calculation:
 * 14 bytes if `Time` is specified, plus the UTF-8 byte lengths of `Source`,
 * `DetailType`, `Detail`, and each entry in `Resources`.
 */
const entrySize = (entry: BusSinkEntry): number => {
  let size = entry.Time !== undefined ? 14 : 0;
  if (entry.Source !== undefined) {
    size += encoder.encode(entry.Source).length;
  }
  if (entry.DetailType !== undefined) {
    size += encoder.encode(entry.DetailType).length;
  }
  if (entry.Detail !== undefined) {
    size += encoder.encode(entry.Detail).length;
  }
  for (const resource of entry.Resources ?? []) {
    size += encoder.encode(resource).length;
  }
  return size;
};

/**
 * Per-entry error codes EventBridge documents as retryable. Every other
 * `ErrorCode` (`MalformedDetail`, `AccessDeniedException`, ...) is permanent.
 */
const TRANSIENT_ERROR_CODES: ReadonlySet<string> = new Set([
  "ThrottlingException",
  "InternalFailure",
]);

/**
 * Select the original entries whose positional `PutEventsResultEntry` carries
 * an `ErrorCode` of the given transience, preserving input order (the result
 * `Entries` array is aligned index-for-index with the request entries).
 */
const selectFailed = (
  out: eventbridge.PutEventsResponse,
  batch: readonly BusSinkEntry[],
  transient: boolean,
): readonly BusSinkEntry[] => {
  const results = out.Entries;
  if (results === undefined || (out.FailedEntryCount ?? 0) === 0) {
    return [];
  }
  return batch.filter((_, index) => {
    const code = results[index]?.ErrorCode;
    return code !== undefined && TRANSIENT_ERROR_CODES.has(code) === transient;
  });
};

/**
 * HTTP implementation of {@link BusSink}. At deploy time it grants
 * `events:PutEvents` on the bound bus (or the default bus); at runtime it
 * batches stream elements into `PutEvents` calls (10 entries / 256 KiB) with
 * bounded retry of transient per-entry failures. Provide this layer on the
 * Function using the sink.
 */
export const BusSinkHttp = Layer.effect(
  BusSink,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const putEvents = yield* PutEvents;

    return Effect.fn(function* (bus?: EventBus) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const { accountId, region } = yield* AWSEnvironment.current as unknown as Effect.Effect<{
          accountId: string;
          region: string;
        }>;
        // Pass the ARN as an unresolved Output — binding data is resolved
        // by the engine before the host reconciles (see PutEventsHttp).
        const resource = bus
          ? Output.interpolate`${bus.eventBusArn}`
          : (`arn:aws:events:${region}:${accountId}:event-bus/default` as const);

        yield* bind`AWS.EventBridge.BusSink(${bus ?? "default"})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["events:PutEvents"],
              Resource: [resource],
            },
          ],
        });
      }
      const put = yield* putEvents(bus);
      return makeBatchedSink<
        BusSinkEntry,
        eventbridge.PutEventsResponse,
        eventbridge.PutEventsError
      >({
        maxRecords: 10,
        maxBytes: 262_144,
        sizeOf: entrySize,
        send: (batch) => put({ Entries: [...batch] }),
        // ThrottlingException / InternalFailure are transient — re-submit
        // them on the bounded schedule.
        unprocessed: (out, batch) => selectFailed(out, batch, true),
        // Any other per-entry ErrorCode (e.g. MalformedDetail) is permanent —
        // drop and surface.
        rejected: (out, batch) => selectFailed(out, batch, false),
      });
    });
  }),
);
