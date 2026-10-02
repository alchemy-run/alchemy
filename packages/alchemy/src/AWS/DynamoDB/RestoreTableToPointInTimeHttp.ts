import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { grantTables, signed, tablesRegion } from "./BindingHttp.ts";
import {
  RestoreTableToPointInTime,
  type RestoreTableToPointInTimeRequest,
} from "./RestoreTableToPointInTime.ts";
import type { Table } from "./Table.ts";

export const RestoreTableToPointInTimeHttp = Layer.effect(
  RestoreTableToPointInTime,
  Effect.gen(function* () {
    return Effect.fn(function* <From extends Table, To extends Table>(
      from: From,
      to: To,
    ) {
      const SourceTableName = yield* from.tableName;
      const TargetTableName = yield* to.tableName;
      const access = yield* grantTables(
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
      const region = yield* tablesRegion(access, [from, to]);
      return Effect.fn(
        `AWS.DynamoDB.RestoreTableToPointInTime(${from.LogicalId}, ${to.LogicalId})`,
      )(function* (request: RestoreTableToPointInTimeRequest) {
        return yield* signed(
          access,
          region,
          DynamoDB.restoreTableToPointInTime({
            ...request,
            SourceTableName: yield* SourceTableName,
            TargetTableName: yield* TargetTableName,
          }),
        );
      });
    });
  }),
);
