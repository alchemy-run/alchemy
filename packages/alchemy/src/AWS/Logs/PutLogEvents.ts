import type * as Logs from "@distilled.cloud/aws/cloudwatch-logs";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { LogGroup } from "./LogGroup.ts";

export type InputLogEvent = Logs.InputLogEvent;

export interface PutLogEventsRequest extends Omit<
  Logs.PutLogEventsRequest,
  "logGroupName" | "sequenceToken"
> {}

/**
 * Runtime binding for `logs:PutLogEvents`.
 *
 * Bind this operation to a `LogGroup` inside a function runtime to get a
 * callable that writes log events to a stream of the group (e.g. custom audit
 * trails), automatically injecting the log group name. The target log stream
 * must already exist (declare an `AWS.Logs.LogStream`). Sequence tokens are no
 * longer required by CloudWatch Logs.
 * @binding
 * @section Writing Logs
 * @example Write an Audit Event
 * ```typescript
 * const putLogEvents = yield* AWS.Logs.PutLogEvents(logGroup);
 *
 * yield* putLogEvents({
 *   logStreamName: stream.logStreamName,
 *   logEvents: [{ timestamp: now, message: "user.login id=123" }],
 * });
 * ```
 */
export interface PutLogEvents extends Binding.Service<
  PutLogEvents,
  "AWS.Logs.PutLogEvents",
  <G extends LogGroup>(
    logGroup: G,
  ) => Effect.Effect<
    (
      request: PutLogEventsRequest,
    ) => Effect.Effect<Logs.PutLogEventsResponse, Logs.PutLogEventsError>
  >
> {}
export const PutLogEvents = Binding.Service<PutLogEvents>(
  "AWS.Logs.PutLogEvents",
);
