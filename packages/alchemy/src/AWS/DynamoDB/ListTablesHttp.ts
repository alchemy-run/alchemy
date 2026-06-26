import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import { ListTables, type ListTablesRequest } from "./ListTables.ts";

export const ListTablesHttp = Layer.effect(
  ListTables,
  Effect.gen(function* () {
    const listTables = yield* DynamoDB.listTables;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.DynamoDB.ListTables())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["dynamodb:ListTables"],
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn("AWS.DynamoDB.ListTables")(function* (
        request?: ListTablesRequest,
      ) {
        return yield* listTables(request ?? {});
      });
    });
  }),
);
