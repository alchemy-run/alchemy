import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { Table } from "./Table.ts";

export interface GetItemRequest extends Omit<
  DynamoDB.GetItemInput,
  "TableName"
> {}

export class GetItem extends Binding.Service<
  GetItem,
  <T extends Table>(
    table: T,
  ) => Effect.Effect<
    (
      request: GetItemRequest,
    ) => Effect.Effect<DynamoDB.GetItemOutput, DynamoDB.GetItemError>
  >
>()("AWS.DynamoDB.GetItem") {}

export const GetItemLive = Layer.effect(
  GetItem,
  Effect.gen(function* () {
    const Policy = yield* GetItemPolicy;
    const getItem = yield* DynamoDB.getItem;

    return Effect.fn(function* <T extends Table>(table: T) {
      const TableName = yield* table.tableName;
      yield* Policy(table);
      return Effect.fn(function* (request: GetItemRequest) {
        const tableName = yield* TableName;
        return yield* getItem({
          ...request,
          TableName: tableName,
        });
      });
    });
  }),
);

export class GetItemPolicy extends Binding.Policy<
  GetItemPolicy,
  <T extends Table>(table: T) => Effect.Effect<void>
>()("AWS.DynamoDB.GetItem") {}

export const GetItemPolicyLive = GetItemPolicy.layer.succeed(
  Effect.fn(function* (host, table) {
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
    } else {
      return yield* Effect.die(
        `GetItemPolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);
