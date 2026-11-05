import type * as Logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import { type BatchRetryExhaustedError, makeBatchedSink } from "alchemy/Util/BatchedSink";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Sink from "effect/Sink";
import * as AWSBindings from "../AWSBindings.ts";
import type { LogGroup } from "./LogGroup.ts";
import { PutLogEvents } from "./PutLogEvents.ts";

export interface LogEventSinkProps {
  /**
   * Name of the target log stream. The stream must already exist — declare an
   * `AWS.Logs.LogStream` alongside the log group.
   */
  readonly logStreamName: string;
}

export type LogEventSinkError =
  | Logs.PutLogEventsError
  | BatchRetryExhaustedError<Logs.InputLogEvent>;

/**
 * A batching sink over CloudWatch Logs `PutLogEvents` (10,000 events /
 * 1,048,576 bytes per call, where each event costs its UTF-8 message size
 * plus 26 bytes of overhead).
 *
 * Each input element is a raw `InputLogEvent`, so ordering stays with the
 * caller: `PutLogEvents` requires events in chronological order by
 * `timestamp`, and the time span within one batch must not exceed 24 hours.
 *
 * Events the API reports via `rejectedLogEventsInfo` (older than 14 days or
 * the group's retention period, expired, or more than 2 hours in the future)
 * are **permanently** rejected — they are dropped and surfaced with a
 * warning, never retried. The remaining valid events in the batch are still
 * ingested by the API.
 *
 * ### Streaming Log Events
 * **Example:** Drain a Stream of Events into a Log Stream
 * ```typescript
 * const sink = yield* AWS.Logs.LogEventSink(logGroup, {
 *   logStreamName: "audit-stream",
 * });
 *
 * // Inside a handler: drain fully before returning.
 * yield* Stream.fromIterable(entries).pipe(
 *   Stream.map((entry) => ({ timestamp: entry.at, message: entry.text })),
 *   Stream.run(sink),
 * );
 * ```
 *
 * **Example:** Wire into a Lambda Function
 * ```typescript
 * // LogEventSinkHttp batches over the PutLogEvents binding, so provide
 * // PutLogEventsHttp into it with Layer.provideMerge.
 * export default IngestFunction.make(
 *   { main: import.meta.url, functionUrl: true },
 *   Effect.gen(function* () {
 *     const logGroup = yield* AWS.Logs.LogGroup("IngestLogs", {});
 *     yield* AWS.Logs.LogStream("IngestStream", {
 *       logGroupName: logGroup.logGroupName,
 *       logStreamName: "ingest-stream",
 *     });
 *     const sink = yield* AWS.Logs.LogEventSink(logGroup, {
 *       logStreamName: "ingest-stream",
 *     });
 *     // ... run streams of InputLogEvents into `sink` in the fetch handler
 *     return { fetch: handler };
 *   }).pipe(
 *     Effect.provide(
 *       Layer.provideMerge(AWS.Logs.LogEventSinkHttp, AWS.Logs.PutLogEventsHttp),
 *     ),
 *   ),
 * );
 * ```
 *
 * @binding
 */
export interface LogEventSink extends Binding.Service<
  LogEventSink,
  "AWS.Logs.LogEventSink",
  (
    logGroup: LogGroup,
    props: LogEventSinkProps,
  ) => Effect.Effect<
    Sink.Sink<void, Logs.InputLogEvent, readonly Logs.InputLogEvent[], LogEventSinkError>
  >
> {}

export const LogEventSink = Binding.Service<LogEventSink>("AWS.Logs.LogEventSink");

const encoder = new TextEncoder();

/**
 * The `PutLogEvents` batch-size formula charges each event its UTF-8 message
 * size plus 26 bytes of overhead.
 */
const PER_EVENT_OVERHEAD = 26;

/**
 * Select the events `rejectedLogEventsInfo` marks as permanently rejected,
 * preserving input order. The API skips (never ingests) these while still
 * processing the remaining valid events, so they must be dropped — not
 * retried:
 *
 * - `tooOldLogEventEndIndex` / `expiredLogEventEndIndex` — everything up to
 *   and including that index is too old / past retention;
 * - `tooNewLogEventStartIndex` — everything from that index on is more than
 *   2 hours in the future.
 */
const selectRejected = (
  out: Logs.PutLogEventsResponse,
  batch: readonly Logs.InputLogEvent[],
): readonly Logs.InputLogEvent[] => {
  const info = out.rejectedLogEventsInfo;
  if (info === undefined) {
    return [];
  }
  const rejectedHeadEnd = Math.max(
    info.tooOldLogEventEndIndex ?? -1,
    info.expiredLogEventEndIndex ?? -1,
  );
  const tooNewStart = info.tooNewLogEventStartIndex ?? batch.length;
  return batch.filter((_, index) => index <= rejectedHeadEnd || index >= tooNewStart);
};

export const LogEventSinkHttp = Layer.effect(
  LogEventSink,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const putLogEvents = yield* PutLogEvents;

    return Effect.fn(function* (logGroup: LogGroup, props: LogEventSinkProps) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.Logs.LogEventSink(${logGroup})`({
          policyStatements: [
            {
              // PutLogEvents authorizes against the log-stream resource
              // (`log-group:{name}:log-stream:{stream}`), covered by the
              // `:*` wildcard on the group ARN.
              Effect: "Allow",
              Action: ["logs:PutLogEvents"],
              Resource: [Output.interpolate`${logGroup.logGroupArn}:*`],
            },
          ],
        });
      }
      const put = yield* putLogEvents(logGroup);
      return makeBatchedSink<Logs.InputLogEvent, Logs.PutLogEventsResponse, Logs.PutLogEventsError>(
        {
          maxRecords: 10_000,
          maxBytes: 1_048_576,
          sizeOf: (event) => encoder.encode(event.message).length + PER_EVENT_OVERHEAD,
          send: (batch) =>
            put({
              logStreamName: props.logStreamName,
              logEvents: [...batch],
            }),
          // No `unprocessed` extractor: PutLogEvents has no transient per-event
          // failure mode — timestamp rejections are permanent, so drop + surface.
          rejected: selectRejected,
        },
      );
    });
  }),
);
