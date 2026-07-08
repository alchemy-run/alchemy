import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import type { Table } from "./Table.ts";
import { DescribeTable, type DescribeTableRequest } from "./DescribeTable.ts";

export const DescribeTableHttp = Layer.effect(
  DescribeTable,
  Effect.gen(function* () {
    const describeTable = yield* DynamoDB.describeTable;

    return Effect.fn(function* <T extends Table>(table: T) {
      const TableName = yield* table.tableName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.DynamoDB.DescribeTable(${table}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["dynamodb:DescribeTable"],
                  Resource: [table.tableArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.DynamoDB.DescribeTable(${table.LogicalId})`)(
        function* (request?: DescribeTableRequest) {
          return yield* describeTable({
            ...request,
            TableName: yield* TableName,
          });
        },
      );
    });
  }),
);
