import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import type { Table } from "./Table.ts";
import { UpdateItem, type UpdateItemRequest } from "./UpdateItem.ts";

export const UpdateItemHttp = Layer.effect(
  UpdateItem,
  Effect.gen(function* () {
    const updateItem = yield* DynamoDB.updateItem;

    return Effect.fn(function* <T extends Table>(table: T) {
      const TableName = yield* table.tableName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.DynamoDB.UpdateItem(${table}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["dynamodb:UpdateItem"],
                Resource: [table.tableArn],
              },
            ],
          });
        }
      }
      return Effect.fn(`AWS.DynamoDB.UpdateItem(${table.LogicalId})`)(
        function* (request: UpdateItemRequest) {
          const tableName = yield* TableName;
          return yield* updateItem({
            ...request,
            TableName: tableName,
          });
        },
      );
    });
  }),
);
