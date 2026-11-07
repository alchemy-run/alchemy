import * as cloudtrail from "@distilled.cloud/aws/cloudtrail";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import type { EventDataStore } from "./EventDataStore.ts";

/**
 * Request for the {@link StartQuery} binding. CloudTrail Lake SQL references
 * the event data store by its ID (the ARN's `eventdatastore/` suffix) in the
 * `FROM` clause, so `QueryStatement` may be a function that receives the
 * bound store's ID and returns the SQL text.
 */
export interface StartQueryRequest extends Omit<cloudtrail.StartQueryRequest, "QueryStatement"> {
  /**
   * The SQL statement, or a function producing it from the bound event data
   * store's ID (for the `FROM <eventDataStoreId>` clause).
   */
  QueryStatement: string | ((eventDataStoreId: string) => string);
}

/**
 * Runtime binding for `cloudtrail:StartQuery`.
 *
 * Starts a CloudTrail Lake SQL query against the bound
 * {@link EventDataStore} and returns the `QueryId` to poll with
 * {@link DescribeQuery} / {@link GetQueryResults}. Provide the implementation
 * with `Effect.provide(AWS.CloudTrail.StartQueryHttp)`.
 * ### Querying CloudTrail Lake
 * **Example:** Start a Lake Query
 * ```typescript
 * // init — bind the operation to the event data store
 * const startQuery = yield* AWS.CloudTrail.StartQuery(store);
 *
 * // runtime — the callback receives the store's ID for the FROM clause
 * const { QueryId } = yield* startQuery({
 *   QueryStatement: (id) =>
 *     `SELECT eventID, eventName FROM ${id} LIMIT 10`,
 * });
 * ```
 *
 * @binding
 */
export interface StartQuery extends Binding.Service<
  StartQuery,
  "AWS.CloudTrail.StartQuery",
  (
    store: EventDataStore,
  ) => Effect.Effect<
    (
      request: StartQueryRequest,
    ) => Effect.Effect<cloudtrail.StartQueryResponse, cloudtrail.StartQueryError>
  >
> {}
export const StartQuery = Binding.Service<StartQuery>("AWS.CloudTrail.StartQuery");

/**
 * Bespoke (not scaffolded): the runtime callable resolves the bound store's
 * ID out of its ARN and threads it through a `QueryStatement` callback —
 * CloudTrail Lake SQL references the store by ID in the `FROM` clause rather
 * than as a request field.
 */
export const StartQueryHttp = Layer.effect(
  StartQuery,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const startQuery = yield* AWSBindings.withCredentials(cloudtrail.startQuery);

    return Effect.fn(function* (store: EventDataStore) {
      const Arn = yield* store.eventDataStoreArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.CloudTrail.StartQuery(${store})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["cloudtrail:StartQuery"],
              Resource: [store.eventDataStoreArn],
            },
          ],
        });
      }
      return Effect.fn(`AWS.CloudTrail.StartQuery(${store.LogicalId})`)(function* (
        request: StartQueryRequest,
      ) {
        const arn = yield* Arn;
        const eventDataStoreId = arn.split("/").pop()!;
        const { QueryStatement, ...rest } = request;
        return yield* startQuery({
          ...rest,
          QueryStatement:
            typeof QueryStatement === "function"
              ? QueryStatement(eventDataStoreId)
              : QueryStatement,
        });
      });
    });
  }),
);
