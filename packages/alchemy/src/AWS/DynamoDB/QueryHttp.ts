import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import * as Output from "../../Output.ts";
import { isFunction } from "../Lambda/Function.ts";
import { Query, type QueryRequest } from "./Query.ts";
import type { Table } from "./Table.ts";

export const QueryHttp = Layer.effect(
  Query,
  Effect.gen(function* () {
    const query = yield* DynamoDB.query;

    return Effect.fn(function* <T extends Table>(table: T) {
      const TableName = yield* table.tableName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.DynamoDB.Query(${table}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["dynamodb:Query"],
                Resource: [
                  table.tableArn,
                  Output.interpolate`${table.tableArn}/index/*`,
                ],
              },
            ],
          });
        }
      }
      return Effect.fn(`AWS.DynamoDB.Query(${table.LogicalId})`)(function* (
        request: QueryRequest,
      ) {
        const tableName = yield* TableName;
        return yield* query({
          ...request,
          TableName: tableName,
        });
      });
    });
  }),
);
