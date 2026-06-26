import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import {
  DescribeTimeToLive,
  type DescribeTimeToLiveRequest,
} from "./DescribeTimeToLive.ts";
import type { Table } from "./Table.ts";

export const DescribeTimeToLiveHttp = Layer.effect(
  DescribeTimeToLive,
  Effect.gen(function* () {
    const describeTimeToLive = yield* DynamoDB.describeTimeToLive;

    return Effect.fn(function* <T extends Table>(table: T) {
      const TableName = yield* table.tableName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.DynamoDB.DescribeTimeToLive(${table}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["dynamodb:DescribeTimeToLive"],
                  Resource: [table.tableArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.DynamoDB.DescribeTimeToLive(${table.LogicalId})`)(
        function* (request?: DescribeTimeToLiveRequest) {
          return yield* describeTimeToLive({
            ...request,
            TableName: yield* TableName,
          });
        },
      );
    });
  }),
);
