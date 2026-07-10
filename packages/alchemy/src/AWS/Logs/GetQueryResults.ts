import type * as Logs from "@distilled.cloud/aws/cloudwatch-logs";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { LogGroup } from "./LogGroup.ts";

export interface GetQueryResultsRequest extends Logs.GetQueryResultsRequest {}

/**
 * Runtime binding for `logs:GetQueryResults` (CloudWatch Logs Insights).
 *
 * Bind this operation to the `LogGroup` an Insights query was started against
 * (via {@link import("./StartQuery.ts").StartQuery}) to poll for its results.
 * @binding
 * @section Logs Insights
 * @example Poll Query Results
 * ```typescript
 * const getQueryResults = yield* AWS.Logs.GetQueryResults(logGroup);
 *
 * const response = yield* getQueryResults({ queryId });
 * if (response.status === "Complete") {
 *   // response.results is an array of field/value rows
 * }
 * ```
 */
export interface GetQueryResults extends Binding.Service<
  GetQueryResults,
  "AWS.Logs.GetQueryResults",
  <G extends LogGroup>(
    logGroup: G,
  ) => Effect.Effect<
    (
      request: GetQueryResultsRequest,
    ) => Effect.Effect<Logs.GetQueryResultsResponse, Logs.GetQueryResultsError>
  >
> {}
export const GetQueryResults = Binding.Service<GetQueryResults>(
  "AWS.Logs.GetQueryResults",
);
