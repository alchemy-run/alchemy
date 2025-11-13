import { $, type } from "alchemy-effect";
import * as DynamoDB from "alchemy-effect/aws/dynamodb";
import * as Lambda from "alchemy-effect/aws/lambda";
import * as SQS from "alchemy-effect/aws/sqs";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";

export interface User {
  id: `USER#${string}`;
  name: string;
  age: number;
}

export interface CartItem {
  id: `CART_ITEM#${string}`;
  name: string;
  productId: string;
}

export class SingleTable extends DynamoDB.Table("Users", {
  partitionKey: "id",
  sortKey: "name",
  items: type<User | CartItem>,
  attributes: {
    id: S.String,
    name: S.String,
  },
}) {}

export class Api extends Lambda.serve("Api", {
  fetch: Effect.fn(function* (event) {
    const id = "USER#123";

    const item = yield* DynamoDB.getItem({
      table: SingleTable,
      key: {
        id,
        name: "world",
      },
      projectionExpression: `${$.join(["id", "name"], ",")}, age`,
    }).pipe(Effect.catchAll(() => Effect.succeed(undefined)));

    return {
      body: JSON.stringify(item?.Item),
    };
  }),
})({
  main: import.meta.filename,
  // Infer instead of hard-code - always least-privilege
  // TODO(sam): implement the compiler plugin
  // bindings: $.infer(),
  // OR: do it manually if you want to manually enforce a policy scope
  bindings: $(
    DynamoDB.GetItem(SingleTable, {
      leadingKeys: $.anyOf("USER#123"),
      attributes: $.anyOf("id", "name", "age"),
    }),
  ),
}) {}

export default Api.handler.pipe(
  Effect.provide(Layer.mergeAll(SQS.clientFromEnv(), DynamoDB.clientFromEnv())),
  Lambda.toHandler,
);
