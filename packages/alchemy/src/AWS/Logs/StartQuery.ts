import type * as Logs from "@distilled.cloud/aws/cloudwatch-logs";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { LogGroup } from "./LogGroup.ts";

export interface StartQueryRequest extends Omit<
  Logs.StartQueryRequest,
  "logGroupName" | "logGroupNames" | "logGroupIdentifiers"
> {}

/**
 * Runtime binding for `logs:StartQuery` (CloudWatch Logs Insights).
 *
 * Bind this operation to a `LogGroup` inside a function runtime to get a
 * callable that starts an Insights query scoped to the group, automatically
 * injecting the log group name. Pair with
 * {@link import("./GetQueryResults.ts").GetQueryResults} to poll for results.
 * @binding
 * @section Logs Insights
 * @example Start an Insights Query
 * ```typescript
 * const startQuery = yield* AWS.Logs.StartQuery(logGroup);
 *
 * const { queryId } = yield* startQuery({
 *   queryString: "fields @timestamp, @message | limit 10",
 *   startTime: startEpochSeconds,
 *   endTime: endEpochSeconds,
 * });
 * ```
 */
export interface StartQuery extends Binding.Service<
  StartQuery,
  "AWS.Logs.StartQuery",
  <G extends LogGroup>(
    logGroup: G,
  ) => Effect.Effect<
    (
      request: StartQueryRequest,
    ) => Effect.Effect<Logs.StartQueryResponse, Logs.StartQueryError>
  >
> {}
export const StartQuery = Binding.Service<StartQuery>("AWS.Logs.StartQuery");
