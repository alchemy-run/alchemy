import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { grantTables, signed, tablesRegion } from "./BindingHttp.ts";
import {
  ExecuteTransaction,
  type ExecuteTransactionRequest,
  type ExecuteTransactionTables,
} from "./ExecuteTransaction.ts";

export const ExecuteTransactionHttp = Layer.effect(
  ExecuteTransaction,
  Effect.gen(function* () {
    return Effect.fn(function* (...tables: ExecuteTransactionTables) {
      const sortedTables = [...tables].sort((a, b) =>
        a.LogicalId.localeCompare(b.LogicalId),
      );
      const access = yield* grantTables(
        `AWS.DynamoDB.ExecuteTransaction(${sortedTables.map((table) => table.LogicalId).join(", ")})`,
        () => [
          {
            Effect: "Allow",
            Action: [
              "dynamodb:PartiQLSelect",
              "dynamodb:PartiQLInsert",
              "dynamodb:PartiQLUpdate",
              "dynamodb:PartiQLDelete",
            ],
            Resource: sortedTables.map((table) => table.tableArn),
          },
        ],
      );
      const region = yield* tablesRegion(access, sortedTables);
      return Effect.fn(`AWS.DynamoDB.ExecuteTransaction(${tables})`)(function* (
        request: ExecuteTransactionRequest,
      ) {
        return yield* signed(
          access,
          region,
          DynamoDB.executeTransaction(request),
        );
      });
    });
  }),
);
