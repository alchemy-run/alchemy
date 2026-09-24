import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Output from "../../Output.ts";
import {
  BatchExecuteStatement,
  type BatchExecuteStatementRequest,
  type BatchExecuteStatementTables,
  sortBatchExecuteStatementTables,
} from "./BatchExecuteStatement.ts";
import { grantTables, signed, tablesRegion } from "./BindingHttp.ts";

export const BatchExecuteStatementHttp = Layer.effect(
  BatchExecuteStatement,
  Effect.gen(function* () {
    return Effect.fn(function* (...tables: BatchExecuteStatementTables) {
      const sortedTables = sortBatchExecuteStatementTables(tables);
      const access = yield* grantTables(
        `AWS.DynamoDB.BatchExecuteStatement(${sortedTables.map((table) => table.LogicalId).join(", ")})`,
        () => [
          {
            Effect: "Allow",
            Action: [
              "dynamodb:PartiQLDelete",
              "dynamodb:PartiQLInsert",
              "dynamodb:PartiQLSelect",
              "dynamodb:PartiQLUpdate",
            ],
            Resource: sortedTables.flatMap((table) => [
              table.tableArn,
              Output.interpolate`${table.tableArn}/index/*`,
            ]),
          },
        ],
      );
      const region = yield* tablesRegion(access, sortedTables);
      return Effect.fn(`AWS.DynamoDB.BatchExecuteStatement(${sortedTables})`)(
        function* (request: BatchExecuteStatementRequest) {
          return yield* signed(
            access,
            region,
            DynamoDB.batchExecuteStatement(request),
          );
        },
      );
    });
  }),
);
