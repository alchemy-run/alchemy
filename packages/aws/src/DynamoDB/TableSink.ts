import type * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Binding from "alchemy/Binding";
import { type BatchRetryExhaustedError, makeBatchedSink } from "alchemy/Util/BatchedSink";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Sink from "effect/Sink";
import { BatchWriteItem } from "./BatchWriteItem.ts";
import { GrantTables } from "./BindingHttp.ts";
import type { Table } from "./Table.ts";

/**
 * A raw distilled `WriteRequest` — exactly one of `PutRequest` or
 * `DeleteRequest`. Entries are NOT auto-marshalled: callers construct the
 * `AttributeValue` maps themselves, keeping full control over item shape,
 * ordering, and partitioning.
 */
export interface TableSinkEntry extends DynamoDB.WriteRequest {}

export type TableSinkError =
  | DynamoDB.BatchWriteItemError
  | BatchRetryExhaustedError<TableSinkEntry>;

/**
 * A batching sink over DynamoDB `BatchWriteItem` (25 write requests / 16 MB
 * per call). Entries the API echoes back in `UnprocessedItems` (throttling,
 * internal errors) are re-submitted on a bounded schedule; exhausting retries
 * fails the sink with a typed `BatchRetryExhaustedError` carrying the
 * stranded entries.
 *
 * Sinks are request-scoped consumers: acquire the sink during the Function's
 * init, drive it with `Stream.run` inside a handler, and let it drain fully
 * before the handler returns.
 *
 * ### Streaming Writes
 * **Example:** Stream Put Requests into a Table
 * ```typescript
 * const sink = yield* AWS.DynamoDB.TableSink(table);
 *
 * yield* Stream.fromIterable(records).pipe(
 *   Stream.map((record): AWS.DynamoDB.TableSinkEntry => ({
 *     PutRequest: {
 *       Item: {
 *         pk: { S: record.pk },
 *         sk: { S: record.sk },
 *       },
 *     },
 *   })),
 *   Stream.run(sink),
 * );
 * ```
 *
 * **Example:** Stream Delete Requests into a Table
 * ```typescript
 * yield* Stream.fromIterable(keys).pipe(
 *   Stream.map((key): AWS.DynamoDB.TableSinkEntry => ({
 *     DeleteRequest: {
 *       Key: {
 *         pk: { S: key.pk },
 *         sk: { S: key.sk },
 *       },
 *     },
 *   })),
 *   Stream.run(sink),
 * );
 * ```
 *
 * @binding
 */
export interface TableSink extends Binding.Service<
  TableSink,
  "AWS.DynamoDB.TableSink",
  (
    table: Table,
  ) => Effect.Effect<Sink.Sink<void, TableSinkEntry, readonly TableSinkEntry[], TableSinkError>>
> {}

export const TableSink = Binding.Service<TableSink>("AWS.DynamoDB.TableSink");

const encoder = new TextEncoder();

/**
 * Map the `UnprocessedItems` echoed by `BatchWriteItem` back onto the
 * original batch entries, preserving input order. The response is
 * deserialized (identity is lost), so entries are matched by canonical JSON
 * as a multiset — DynamoDB rejects batches containing duplicate keys, so a
 * multiset over serialized entries is unambiguous in practice. If any echoed
 * entry fails to match (e.g. key-order drift in the echo), fall back to the
 * echoed entries verbatim so nothing is ever silently dropped from the retry.
 */
const selectUnprocessed = (
  unprocessed: { [key: string]: DynamoDB.WriteRequest[] | undefined } | undefined,
  batch: readonly TableSinkEntry[],
): readonly TableSinkEntry[] => {
  // The sink writes a single table, so at most one key is present.
  const echoed = Object.values(unprocessed ?? {}).flatMap((requests) => requests ?? []);
  if (echoed.length === 0) {
    return [];
  }
  const remaining = new Map<string, number>();
  for (const request of echoed) {
    const key = JSON.stringify(request);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  const matched = batch.filter((entry) => {
    const key = JSON.stringify(entry);
    const count = remaining.get(key) ?? 0;
    if (count === 0) {
      return false;
    }
    remaining.set(key, count - 1);
    return true;
  });
  return matched.length === echoed.length ? matched : echoed;
};

export const TableSinkHttp = Layer.effect(
  TableSink,
  Effect.gen(function* () {
    const grantTables = yield* GrantTables;
    const batchWriteItem = yield* BatchWriteItem;

    return Effect.fn(function* (table: Table) {
      // Requests are signed by the provided `BatchWriteItem` implementation.
      yield* grantTables(`AWS.DynamoDB.TableSink(${table.LogicalId})`, () => [
        {
          Effect: "Allow",
          Action: ["dynamodb:BatchWriteItem"],
          Resource: [table.tableArn],
        },
      ]);
      const write = yield* batchWriteItem(table);
      return makeBatchedSink<
        TableSinkEntry,
        DynamoDB.BatchWriteItemOutput,
        DynamoDB.BatchWriteItemError
      >({
        maxRecords: 25,
        maxBytes: 16_777_216,
        sizeOf: (request) => encoder.encode(JSON.stringify(request)).length,
        send: (batch) => write({ RequestItems: { [table.LogicalId]: [...batch] } }),
        // UnprocessedItems are transient (throttling, internal errors) —
        // re-submit them on the bounded schedule.
        unprocessed: (out, batch) => selectUnprocessed(out.UnprocessedItems, batch),
      });
    });
  }),
);
