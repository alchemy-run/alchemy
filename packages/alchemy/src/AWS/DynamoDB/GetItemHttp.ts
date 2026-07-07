import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import { GetItem, type GetItemRequest } from "./GetItem.ts";
import type { Table } from "./Table.ts";

export const GetItemHttp = Layer.effect(
  GetItem,
  Effect.gen(function* () {
    const getItem = yield* DynamoDB.getItem;

    return Effect.fn(function* <T extends Table>(table: T) {
      const TableName = yield* table.tableName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.DynamoDB.GetItem(${table}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["dynamodb:GetItem"],
                Resource: [table.tableArn],
              },
            ],
          });
        }
      }
      return Effect.fn(`AWS.DynamoDB.GetItem(${table.LogicalId})`)(function* (
        request: GetItemRequest,
      ) {
        const tableName = yield* TableName;
        return yield* getItem({
          ...request,
          TableName: tableName,
        });
      });
    });
  }),
);
