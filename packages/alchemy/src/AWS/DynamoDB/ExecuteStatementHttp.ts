import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import * as Output from "../../Output.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Table } from "./Table.ts";
import {
  ExecuteStatement,
  type ExecuteStatementRequest,
} from "./ExecuteStatement.ts";

export const ExecuteStatementHttp = Layer.effect(
  ExecuteStatement,
  Effect.gen(function* () {
    const executeStatement = yield* DynamoDB.executeStatement;

    return Effect.fn(function* <T extends Table>(table: T) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.DynamoDB.ExecuteStatement(${table}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: [
                    "dynamodb:PartiQLDelete",
                    "dynamodb:PartiQLInsert",
                    "dynamodb:PartiQLSelect",
                    "dynamodb:PartiQLUpdate",
                  ],
                  Resource: [
                    table.tableArn,
                    Output.interpolate`${table.tableArn}/index/*`,
                  ],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.DynamoDB.ExecuteStatement(${table.LogicalId})`)(
        function* (request: ExecuteStatementRequest) {
          return yield* executeStatement(request);
        },
      );
    });
  }),
);
