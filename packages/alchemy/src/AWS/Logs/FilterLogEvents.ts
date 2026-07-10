import type * as Logs from "@distilled.cloud/aws/cloudwatch-logs";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { LogGroup } from "./LogGroup.ts";

export interface FilterLogEventsRequest extends Omit<
  Logs.FilterLogEventsRequest,
  "logGroupName" | "logGroupIdentifier"
> {}

/**
 * Runtime binding for `logs:FilterLogEvents`.
 *
 * Bind this operation to a `LogGroup` inside a function runtime to get a
 * callable that searches log events across all streams of the group,
 * automatically injecting the log group name.
 * @binding
 * @section Reading Logs
 * @example Search for a Marker
 * ```typescript
 * const filterLogEvents = yield* AWS.Logs.FilterLogEvents(logGroup);
 *
 * const response = yield* filterLogEvents({
 *   filterPattern: '"ERROR"',
 *   limit: 100,
 * });
 * ```
 */
export interface FilterLogEvents extends Binding.Service<
  FilterLogEvents,
  "AWS.Logs.FilterLogEvents",
  <G extends LogGroup>(
    logGroup: G,
  ) => Effect.Effect<
    (
      request?: FilterLogEventsRequest,
    ) => Effect.Effect<Logs.FilterLogEventsResponse, Logs.FilterLogEventsError>
  >
> {}
export const FilterLogEvents = Binding.Service<FilterLogEvents>(
  "AWS.Logs.FilterLogEvents",
);
