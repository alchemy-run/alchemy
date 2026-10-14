import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HostAccess from "../HostAccess.ts";
import { grantTables, tablesRegion } from "./BindingHttp.ts";
import {
  ExecuteTransaction,
  type ExecuteTransactionRequest,
  type ExecuteTransactionTables,
} from "./ExecuteTransaction.ts";

export const ExecuteTransactionHttp = Layer.effect(
  ExecuteTransaction,
  Effect.gen(function* () {
    return Effect.fn(function* (...tables: ExecuteTransactionTables) {
      const sortedTables = [...tables].sort((a, b) => a.LogicalId.localeCompare(b.LogicalId));
      yield* grantTables(
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
      const executeTransaction = yield* HostAccess.withCredentials(
        DynamoDB.executeTransaction,
        tablesRegion(sortedTables),
      );
      return Effect.fn(`AWS.DynamoDB.ExecuteTransaction(${tables})`)(function* (
        request: ExecuteTransactionRequest,
      ) {
        return yield* executeTransaction(request);
      });
    });
  }),
);
