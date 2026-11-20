import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import { GrantTables, tablesRegion } from "./BindingHttp.ts";
import type { Table } from "./Table.ts";

export interface RestoreTableFromBackupRequest extends Omit<
  DynamoDB.RestoreTableFromBackupInput,
  "TargetTableName"
> {}

/**
 * Runtime binding for `dynamodb:RestoreTableFromBackup`.
 *
 * Bind this operation to a source and a target `Table` inside a function
 * runtime to get a callable that restores one of the source table's on-demand
 * backups (by `BackupArn`) into the target, automatically injecting the
 * target table name. Provide the `RestoreTableFromBackupHttp` layer on the
 * Function to satisfy the binding.
 * ### Backup and Restore
 * **Example:** Restore a Backup into the Target Table
 * ```typescript
 * const restoreTableFromBackup = yield* AWS.DynamoDB.RestoreTableFromBackup(
 *   sourceTable,
 *   restoreTargetTable,
 * );
 *
 * const response = yield* restoreTableFromBackup({ BackupArn: backupArn });
 * const status = response.TableDescription?.TableStatus;
 * ```
 *
 * @binding
 */
export interface RestoreTableFromBackup extends Binding.Service<
  RestoreTableFromBackup,
  "AWS.DynamoDB.RestoreTableFromBackup",
  <From extends Table, To extends Table>(
    from: From,
    to: To,
  ) => Effect.Effect<
    (
      request: RestoreTableFromBackupRequest,
    ) => Effect.Effect<DynamoDB.RestoreTableFromBackupOutput, DynamoDB.RestoreTableFromBackupError>
  >
> {}
export const RestoreTableFromBackup = Binding.Service<RestoreTableFromBackup>(
  "AWS.DynamoDB.RestoreTableFromBackup",
);

export const RestoreTableFromBackupHttp = Layer.effect(
  RestoreTableFromBackup,
  Effect.gen(function* () {
    const grantTables = yield* GrantTables;
    return Effect.fn(function* <From extends Table, To extends Table>(from: From, to: To) {
      const TargetTableName = yield* to.tableName;
      yield* grantTables(
        `AWS.DynamoDB.RestoreTableFromBackup(${from.LogicalId}, ${to.LogicalId})`,
        () => [
          {
            Effect: "Allow",
            Action: ["dynamodb:RestoreTableFromBackup"],
            Resource: [Output.interpolate`${from.tableArn}/backup/*`],
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
      const restoreTableFromBackup = yield* AWSBindings.withCredentials(
        DynamoDB.restoreTableFromBackup,
        tablesRegion([from, to]),
      );
      return Effect.fn(`AWS.DynamoDB.RestoreTableFromBackup(${from.LogicalId}, ${to.LogicalId})`)(
        function* (request: RestoreTableFromBackupRequest) {
          return yield* restoreTableFromBackup({
            ...request,
            TargetTableName: yield* TargetTableName,
          });
        },
      );
    });
  }),
);
