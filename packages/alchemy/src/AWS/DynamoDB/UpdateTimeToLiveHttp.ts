import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import type { Table } from "./Table.ts";
import {
  UpdateTimeToLive,
  type UpdateTimeToLiveRequest,
} from "./UpdateTimeToLive.ts";

export const UpdateTimeToLiveHttp = Layer.effect(
  UpdateTimeToLive,
  Effect.gen(function* () {
    const updateTimeToLive = yield* DynamoDB.updateTimeToLive;

    return Effect.fn(function* <T extends Table>(table: T) {
      const TableName = yield* table.tableName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.DynamoDB.UpdateTimeToLive(${table}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["dynamodb:UpdateTimeToLive"],
                  Resource: [table.tableArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.DynamoDB.UpdateTimeToLive(${table.LogicalId})`)(
        function* (request: UpdateTimeToLiveRequest) {
          return yield* updateTimeToLive({
            ...request,
            TableName: yield* TableName,
          });
        },
      );
    });
  }),
);
