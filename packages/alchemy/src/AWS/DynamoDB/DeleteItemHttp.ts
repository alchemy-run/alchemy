import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import type { Table } from "./Table.ts";
import { DeleteItem, type DeleteItemRequest } from "./DeleteItem.ts";

export const DeleteItemHttp = Layer.effect(
  DeleteItem,
  Effect.gen(function* () {
    const deleteItem = yield* DynamoDB.deleteItem;

    return Effect.fn(function* <T extends Table>(table: T) {
      const TableName = yield* table.tableName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.DynamoDB.DeleteItem(${table}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["dynamodb:DeleteItem"],
                Resource: [table.tableArn],
              },
            ],
          });
        }
      }
      return Effect.fn(`AWS.DynamoDB.DeleteItem(${table.LogicalId})`)(
        function* (request: DeleteItemRequest) {
          const tableName = yield* TableName;
          return yield* deleteItem({
            ...request,
            TableName: tableName,
          });
        },
      );
    });
  }),
);
