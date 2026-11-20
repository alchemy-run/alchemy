import * as keyspaces from "@distilled.cloud/aws/keyspaces";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import type { Keyspace } from "./Keyspace.ts";
import type { Table } from "./Table.ts";

export interface RestoreTableRequest extends Omit<
  keyspaces.RestoreTableRequest,
  "sourceKeyspaceName" | "sourceTableName" | "targetKeyspaceName"
> {}

/**
 * Runtime binding for `cassandra:Restore` (the Keyspaces `RestoreTable`
 * operation).
 *
 * Bind this operation to a source `Table` (which must have point-in-time
 * recovery enabled) and a target `Keyspace` to get a callable that restores
 * the source table's continuous backup into a new table of the target
 * keyspace, automatically injecting the source keyspace/table and target
 * keyspace names. `RestoreTable` is asynchronous — the response returns the
 * new table's ARN while it provisions in the `RESTORING` state. Provide the
 * `RestoreTableHttp` layer on the Function to satisfy the binding.
 * ### Backup and Restore
 * **Example:** Restore to the Current Time
 * ```typescript
 * const restore = yield* AWS.Keyspaces.RestoreTable(sourceTable, keyspace);
 *
 * const { restoredTableARN } = yield* restore({
 *   targetTableName: "orders_restored",
 * });
 * ```
 *
 * **Example:** Restore to a Point in Time
 * ```typescript
 * const { restoredTableARN } = yield* restore({
 *   targetTableName: "orders_before_incident",
 *   restoreTimestamp: new Date("2026-07-14T12:00:00Z"),
 * });
 * ```
 *
 * @binding
 */
export interface RestoreTable extends Binding.Service<
  RestoreTable,
  "AWS.Keyspaces.RestoreTable",
  <From extends Table, To extends Keyspace>(
    source: From,
    targetKeyspace: To,
  ) => Effect.Effect<
    (
      request: RestoreTableRequest,
    ) => Effect.Effect<keyspaces.RestoreTableResponse, keyspaces.RestoreTableError>
  >
> {}

export const RestoreTable = Binding.Service<RestoreTable>("AWS.Keyspaces.RestoreTable");

/**
 * HTTP implementation of {@link RestoreTable}: grants `cassandra:Select` on
 * the source table plus `cassandra:Restore` (and the `Create`/`TagResource`
 * actions the restore performs) on the target keyspace and its tables, and
 * calls the Keyspaces HTTP API with the function's IAM credentials.
 */
export const RestoreTableHttp = Layer.effect(
  RestoreTable,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const restoreTable = yield* AWSBindings.withCredentials(keyspaces.restoreTable);

    return Effect.fn(function* <From extends Table, To extends Keyspace>(
      source: From,
      targetKeyspace: To,
    ) {
      const SourceKeyspaceName = yield* source.keyspaceName;
      const SourceTableName = yield* source.tableName;
      const TargetKeyspaceName = yield* targetKeyspace.keyspaceName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.Keyspaces.RestoreTable(${source}, ${targetKeyspace})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["cassandra:Select"],
              Resource: [source.tableArn],
            },
            {
              // The keyspace ARN ends with a trailing slash
              // (`.../keyspace/name/`), so its tables match `table/*`.
              Effect: "Allow",
              Action: ["cassandra:Restore", "cassandra:Create", "cassandra:TagResource"],
              Resource: [
                targetKeyspace.keyspaceArn,
                Output.interpolate`${targetKeyspace.keyspaceArn}table/*`,
              ],
            },
          ],
        });
      }
      return Effect.fn(`AWS.Keyspaces.RestoreTable(${source.LogicalId})`)(function* (
        request: RestoreTableRequest,
      ) {
        const sourceKeyspaceName = yield* SourceKeyspaceName;
        const sourceTableName = yield* SourceTableName;
        const targetKeyspaceName = yield* TargetKeyspaceName;
        return yield* restoreTable({
          ...request,
          sourceKeyspaceName,
          sourceTableName,
          targetKeyspaceName,
        });
      });
    });
  }),
);
