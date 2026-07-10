import type * as Logs from "@distilled.cloud/aws/cloudwatch-logs";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { LogGroup } from "./LogGroup.ts";

export interface GetLogEventsRequest extends Omit<
  Logs.GetLogEventsRequest,
  "logGroupName" | "logGroupIdentifier"
> {}

/**
 * Runtime binding for `logs:GetLogEvents`.
 *
 * Bind this operation to a `LogGroup` inside a function runtime to get a
 * callable that reads log events from a single stream of the group,
 * automatically injecting the log group name.
 * @binding
 * @section Reading Logs
 * @example Read a Stream from the Beginning
 * ```typescript
 * const getLogEvents = yield* AWS.Logs.GetLogEvents(logGroup);
 *
 * const response = yield* getLogEvents({
 *   logStreamName: "my-stream",
 *   startFromHead: true,
 * });
 * ```
 */
export interface GetLogEvents extends Binding.Service<
  GetLogEvents,
  "AWS.Logs.GetLogEvents",
  <G extends LogGroup>(
    logGroup: G,
  ) => Effect.Effect<
    (
      request: GetLogEventsRequest,
    ) => Effect.Effect<Logs.GetLogEventsResponse, Logs.GetLogEventsError>
  >
> {}
export const GetLogEvents = Binding.Service<GetLogEvents>(
  "AWS.Logs.GetLogEvents",
);
