import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import { GrantTables, tablesRegion } from "./BindingHttp.ts";
import type { Table } from "./Table.ts";

export interface RestoreTableToPointInTimeRequest extends Omit<
  DynamoDB.RestoreTableToPointInTimeInput,
  "SourceTableArn" | "SourceTableName" | "TargetTableName"
> {}

/**
 * Runtime binding for `dynamodb:RestoreTableToPointInTime`.
 *
 * Bind this operation to a source and a target `Table` inside a function
 * runtime to get a callable that restores the source's point-in-time backup
 * into the target, automatically injecting both table identifiers. The source
 * table must have point-in-time recovery enabled. Provide the
 * `RestoreTableToPointInTimeHttp` layer on the Function to satisfy the
 * binding.
 * ### Backup and Restore
 * **Example:** Restore to the Latest Restorable Time
 * ```typescript
 * const restore = yield* AWS.DynamoDB.RestoreTableToPointInTime(
 *   sourceTable,
 *   restoreTargetTable,
 * );
 *
 * const response = yield* restore({
 *   UseLatestRestorableTime: true,
 * });
 * const status = response.TableDescription?.TableStatus;
 * ```
 *
 * @binding
 */
export interface RestoreTableToPointInTime extends Binding.Service<
  RestoreTableToPointInTime,
  "AWS.DynamoDB.RestoreTableToPointInTime",
  <From extends Table, To extends Table>(
    from: From,
    to: To,
  ) => Effect.Effect<
    (
      request: RestoreTableToPointInTimeRequest,
    ) => Effect.Effect<
      DynamoDB.RestoreTableToPointInTimeOutput,
      DynamoDB.RestoreTableToPointInTimeError
    >
  >
> {}

export const RestoreTableToPointInTime = Binding.Service<RestoreTableToPointInTime>(
  "AWS.DynamoDB.RestoreTableToPointInTime",
);

export const RestoreTableToPointInTimeHttp = Layer.effect(
  RestoreTableToPointInTime,
  Effect.gen(function* () {
    const grantTables = yield* GrantTables;
    return Effect.fn(function* <From extends Table, To extends Table>(from: From, to: To) {
      const SourceTableName = yield* from.tableName;
      const TargetTableName = yield* to.tableName;
      yield* grantTables(
        `AWS.DynamoDB.RestoreTableToPointInTime(${from.LogicalId}, ${to.LogicalId})`,
        () => [
          {
            Effect: "Allow",
            Action: ["dynamodb:RestoreTableToPointInTime"],
            Resource: [from.tableArn],
          },
          {
            Effect: "Allow",
            Action: [
              "dynamodb:PutItem",
              "dynamodb:UpdateItem",
              "dynamodb:DeleteItem",
              "dynamodb:GetItem",
              "dynamodb:Query",
              "dynamodb:Scan",
              "dynamodb:BatchWriteItem",
            ],
            Resource: [to.tableArn],
          },
        ],
      );
      // Restores stay in-region: both tables must share it.
      const restoreTableToPointInTime = yield* AWSBindings.withCredentials(
        DynamoDB.restoreTableToPointInTime,
        tablesRegion([from, to]),
      );
      return Effect.fn(
        `AWS.DynamoDB.RestoreTableToPointInTime(${from.LogicalId}, ${to.LogicalId})`,
      )(function* (request: RestoreTableToPointInTimeRequest) {
        return yield* restoreTableToPointInTime({
          ...request,
          SourceTableName: yield* SourceTableName,
          TargetTableName: yield* TargetTableName,
        });
      });
    });
  }),
);
