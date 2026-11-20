import * as TSQ from "@distilled.cloud/aws/timestream-query";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import { discover, withEndpoint } from "./internal.ts";
import type { ScheduledQuery } from "./ScheduledQuery.ts";

export interface ExecuteScheduledQueryRequest extends Omit<
  TSQ.ExecuteScheduledQueryRequest,
  "ScheduledQueryArn"
> {}

/**
 * Runtime binding for `timestream-query:ExecuteScheduledQuery` — manually
 * run a {@link ScheduledQuery} for a given invocation time (e.g. to backfill
 * a window the schedule missed).
 *
 * Bind the operation to the scheduled query to get a callable with
 * `ScheduledQueryArn` injected automatically.
 *
 * Provide `Timestream.ExecuteScheduledQueryHttp` on the Function to
 * implement the binding.
 *
 * ### Creating Scheduled Queries
 * **Example:** Backfill a missed window
 * ```typescript
 * // init — bind the operation to the scheduled query
 * const executeScheduledQuery = yield* Timestream.ExecuteScheduledQuery(rollup);
 *
 * // runtime — re-run the rollup as-of one hour ago
 * yield* executeScheduledQuery({
 *   InvocationTime: new Date(Date.now() - 60 * 60 * 1000),
 * });
 * ```
 *
 * @binding
 */
export interface ExecuteScheduledQuery extends Binding.Service<
  ExecuteScheduledQuery,
  "AWS.Timestream.ExecuteScheduledQuery",
  (
    scheduledQuery: ScheduledQuery,
  ) => Effect.Effect<
    (
      request: ExecuteScheduledQueryRequest,
    ) => Effect.Effect<
      TSQ.ExecuteScheduledQueryResponse,
      TSQ.ExecuteScheduledQueryError | TSQ.DescribeEndpointsError
    >
  >
> {}

export const ExecuteScheduledQuery = Binding.Service<ExecuteScheduledQuery>(
  "AWS.Timestream.ExecuteScheduledQuery",
);

// Bespoke (not on the BindingHttp scaffold): the only Timestream binding
// scoped to a ScheduledQuery rather than a Table or the account.
export const ExecuteScheduledQueryHttp = Layer.effect(
  ExecuteScheduledQuery,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    // Yield-first captures the operations' services (Credentials/Region/
    // HttpClient) at layer init so the runtime callable is requirement-free.
    const executeScheduledQuery = yield* AWSBindings.withCredentials(TSQ.executeScheduledQuery);
    const describeEndpoints = yield* AWSBindings.withCredentials(TSQ.describeEndpoints);
    const withQueryEndpoint = withEndpoint(discover("query", describeEndpoints({})));
    return Effect.fn(function* (scheduledQuery: ScheduledQuery) {
      const ScheduledQueryArn = yield* scheduledQuery.scheduledQueryArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.Timestream.ExecuteScheduledQuery(${scheduledQuery})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["timestream:ExecuteScheduledQuery"],
              Resource: [Output.interpolate`${scheduledQuery.scheduledQueryArn}`],
            },
            // Endpoint discovery is required and is not scoped to a
            // resource.
            {
              Effect: "Allow",
              Action: ["timestream:DescribeEndpoints"],
              Resource: ["*"],
            },
          ],
        });
      }
      return Effect.fn(`AWS.Timestream.ExecuteScheduledQuery(${scheduledQuery.LogicalId})`)(
        function* (request: ExecuteScheduledQueryRequest) {
          return yield* withQueryEndpoint(
            executeScheduledQuery({
              ...request,
              ScheduledQueryArn: yield* ScheduledQueryArn,
            }),
          );
        },
      );
    });
  }),
);
