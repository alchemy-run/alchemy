import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import { PutItem, type PutItemRequest } from "./PutItem.ts";
import type { Table } from "./Table.ts";

export const PutItemHttp = Layer.effect(
  PutItem,
  Effect.gen(function* () {
    const putItem = yield* DynamoDB.putItem;

    return Effect.fn(function* <T extends Table>(table: T) {
      const TableName = yield* table.tableName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.DynamoDB.PutItem(${table}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["dynamodb:PutItem"],
                Resource: [table.tableArn],
              },
            ],
          });
        }
      }
      return Effect.fn(`AWS.DynamoDB.PutItem(${table.LogicalId})`)(function* (
        request: PutItemRequest,
      ) {
        const tableName = yield* TableName;
        return yield* putItem({
          ...request,
          TableName: tableName,
        });
      });
    });
  }),
);
