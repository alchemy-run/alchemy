import * as keyspacesstreams from "@distilled.cloud/aws/keyspacesstreams";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import type { Table } from "./Table.ts";

export interface ListTableStreamsRequest extends Omit<
  keyspacesstreams.ListStreamsInput,
  "keyspaceName" | "tableName"
> {}

/**
 * The typed client returned by binding {@link TableStreams} to a `Table`.
 * `listStreams` automatically injects the table's keyspace and table name;
 * the remaining operations traverse a stream by ARN / shard iterator
 * obtained from prior calls.
 */
export interface TableStreamsClient {
  /**
   * List the CDC streams of the bound table (the stream with the greatest
   * `streamLabel` is the current one — also exposed as the table's
   * `latestStreamArn` attribute).
   */
  listStreams: (
    request?: ListTableStreamsRequest,
  ) => Effect.Effect<keyspacesstreams.ListStreamsOutput, keyspacesstreams.ListStreamsError>;
  /**
   * Describe a stream: status, view type, retention, and shard composition.
   */
  getStream: (
    request: keyspacesstreams.GetStreamInput,
  ) => Effect.Effect<keyspacesstreams.GetStreamOutput, keyspacesstreams.GetStreamError>;
  /**
   * Obtain an iterator positioned in a shard (`TRIM_HORIZON`, `LATEST`,
   * `AT_SEQUENCE_NUMBER`, or `AFTER_SEQUENCE_NUMBER`).
   */
  getShardIterator: (
    request: keyspacesstreams.GetShardIteratorInput,
  ) => Effect.Effect<
    keyspacesstreams.GetShardIteratorOutput,
    keyspacesstreams.GetShardIteratorError
  >;
  /**
   * Read change records from a shard iterator.
   */
  getRecords: (
    request: keyspacesstreams.GetRecordsInput,
  ) => Effect.Effect<keyspacesstreams.GetRecordsOutput, keyspacesstreams.GetRecordsError>;
}

/**
 * Runtime binding for the Amazon Keyspaces CDC streams data-plane API
 * (`cassandra:ListStreams` / `GetStream` / `GetShardIterator` /
 * `GetRecords`).
 *
 * Bind this to a `Table` whose `cdcSpecification` is enabled to get a typed
 * client for traversing the table's change-data-capture stream.
 * ### Reading Change Data
 * **Example:** Traverse the Latest Stream
 * ```typescript
 * const streams = yield* AWS.Keyspaces.TableStreams(table);
 *
 * const { streams: available } = yield* streams.listStreams();
 * const streamArn = available![0].streamArn;
 *
 * const stream = yield* streams.getStream({ streamArn });
 * const { shardIterator } = yield* streams.getShardIterator({
 *   streamArn,
 *   shardId: stream.shards![0].shardId!,
 *   shardIteratorType: "TRIM_HORIZON",
 * });
 *
 * const { changeRecords } = yield* streams.getRecords({
 *   shardIterator: shardIterator!,
 * });
 * ```
 *
 * @binding
 */
export interface TableStreams extends Binding.Service<
  TableStreams,
  "AWS.Keyspaces.TableStreams",
  <T extends Table>(table: T) => Effect.Effect<TableStreamsClient>
> {}
export const TableStreams = Binding.Service<TableStreams>("AWS.Keyspaces.TableStreams");

/**
 * HTTP implementation of {@link TableStreams}: grants the CDC stream read
 * actions (`cassandra:ListStreams` / `GetStream` / `GetShardIterator` /
 * `GetRecords`) on the bound table and its streams, and calls the Keyspaces
 * streams HTTP API with the function's IAM credentials.
 */
export const TableStreamsHttp = Layer.effect(
  TableStreams,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const listStreams = yield* AWSBindings.withCredentials(keyspacesstreams.listStreams);
    const getStream = yield* AWSBindings.withCredentials(keyspacesstreams.getStream);
    const getShardIterator = yield* AWSBindings.withCredentials(keyspacesstreams.getShardIterator);
    const getRecords = yield* AWSBindings.withCredentials(keyspacesstreams.getRecords);

    return Effect.fn(function* <T extends Table>(table: T) {
      const KeyspaceName = yield* table.keyspaceName;
      const TableName = yield* table.tableName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.Keyspaces.TableStreams(${table})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: [
                "cassandra:GetRecords",
                "cassandra:GetShardIterator",
                "cassandra:GetStream",
                "cassandra:ListStreams",
              ],
              Resource: [table.tableArn, Output.interpolate`${table.tableArn}/stream/*`],
            },
          ],
        });
      }
      const logicalId = table.LogicalId;
      const client: TableStreamsClient = {
        listStreams: Effect.fn(`AWS.Keyspaces.TableStreams.listStreams(${logicalId})`)(function* (
          request?: ListTableStreamsRequest,
        ) {
          const keyspaceName = yield* KeyspaceName;
          const tableName = yield* TableName;
          return yield* listStreams({ ...request, keyspaceName, tableName });
        }),
        getStream: Effect.fn(`AWS.Keyspaces.TableStreams.getStream(${logicalId})`)(function* (
          request: keyspacesstreams.GetStreamInput,
        ) {
          return yield* getStream(request);
        }),
        getShardIterator: Effect.fn(`AWS.Keyspaces.TableStreams.getShardIterator(${logicalId})`)(
          function* (request: keyspacesstreams.GetShardIteratorInput) {
            return yield* getShardIterator(request);
          },
        ),
        getRecords: Effect.fn(`AWS.Keyspaces.TableStreams.getRecords(${logicalId})`)(function* (
          request: keyspacesstreams.GetRecordsInput,
        ) {
          return yield* getRecords(request);
        }),
      };
      return client;
    });
  }),
);
