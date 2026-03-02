import type { ConsumedCapacity } from "distilled-aws/dynamodb";
import * as DynamoDB from "distilled-aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import * as Lambda from "../Lambda/index.ts";
import { fromAttributeValue } from "./AttributeValue.ts";
import type { Table } from "./Table.ts";

export interface GetItemRequest extends Omit<
  DynamoDB.GetItemInput,
  "TableName" | "Key"
> {
  Key: Record<string, any>;
}

export interface GetItemResult {
  Item: Record<string, any> | undefined;
  ConsumedCapacity?: ConsumedCapacity;
}

export class GetItem extends Binding.Service<
  GetItem,
  <T extends Table>(
    table: T,
  ) => Effect.Effect<
    (
      request: GetItemRequest,
    ) => Effect.Effect<GetItemResult, DynamoDB.GetItemError>
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
        const { Item, ...rest } = yield* getItem({
          ...request,
          TableName: tableName,
          Key: {
            [table.Props.partitionKey]: {
              S: (request.Key as any)[table.Props.partitionKey] as string,
            },
            ...(table.Props.sortKey
              ? {
                  [table.Props.sortKey]: {
                    S: (request.Key as any)[table.Props.sortKey] as string,
                  },
                }
              : {}),
          },
        });

        return {
          ...rest,
          Item: Item
            ? (Object.fromEntries(
                yield* Effect.promise(() =>
                  Promise.all(
                    Object.entries(Item!).map(async ([key, value]) => [
                      key,
                      await fromAttributeValue(value!),
                    ]),
                  ),
                ),
              ) as any)
            : undefined,
        };
      });
    });
  }),
);

export class GetItemPolicy extends Binding.Policy<
  GetItemPolicy,
  <T extends Table>(table: T) => Effect.Effect<void>
>()("AWS.DynamoDB.GetItem") {}

export const GetItemPolicyLive = GetItemPolicy.layer.succeed(
  Effect.fn(function* (ctx, table) {
    if (Lambda.isFunction(ctx)) {
      yield* ctx.bind({
        policyStatements: [
          {
            Sid: "GetItem",
            Effect: "Allow",
            Action: ["dynamodb:GetItem"],
            Resource: [Output.interpolate`${table.tableArn}`],
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `GetItemPolicy does not support runtime '${ctx.type}'`,
      );
    }
  }),
);
