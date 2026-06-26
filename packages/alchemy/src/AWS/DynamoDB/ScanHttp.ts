import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import * as Output from "../../Output.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Table } from "./Table.ts";
import { Scan, type ScanRequest } from "./Scan.ts";

export const ScanHttp = Layer.effect(
  Scan,
  Effect.gen(function* () {
    const scan = yield* DynamoDB.scan;

    return Effect.fn(function* <T extends Table>(table: T) {
      const TableName = yield* table.tableName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.DynamoDB.Scan(${table}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["dynamodb:Scan"],
                Resource: [
                  table.tableArn,
                  Output.interpolate`${table.tableArn}/index/*`,
                ],
              },
            ],
          });
        }
      }
      return Effect.fn(`AWS.DynamoDB.Scan(${table.LogicalId})`)(function* (
        request: ScanRequest,
      ) {
        const tableName = yield* TableName;
        return yield* scan({
          ...request,
          TableName: tableName,
        });
      });
    });
  }),
);
