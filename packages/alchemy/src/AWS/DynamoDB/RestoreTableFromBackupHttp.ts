import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Output from "../../Output.ts";
import { grantTables, signed, tablesRegion } from "./BindingHttp.ts";
import {
  RestoreTableFromBackup,
  type RestoreTableFromBackupRequest,
} from "./RestoreTableFromBackup.ts";
import type { Table } from "./Table.ts";

export const RestoreTableFromBackupHttp = Layer.effect(
  RestoreTableFromBackup,
  Effect.gen(function* () {
    return Effect.fn(function* <From extends Table, To extends Table>(
      from: From,
      to: To,
    ) {
      const TargetTableName = yield* to.tableName;
      const access = yield* grantTables(
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
      const region = yield* tablesRegion(access, [from, to]);
      return Effect.fn(
        `AWS.DynamoDB.RestoreTableFromBackup(${from.LogicalId}, ${to.LogicalId})`,
      )(function* (request: RestoreTableFromBackupRequest) {
        return yield* signed(
          access,
          region,
          DynamoDB.restoreTableFromBackup({
            ...request,
            TargetTableName: yield* TargetTableName,
          }),
        );
      });
    });
  }),
);
