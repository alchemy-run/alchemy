import type {
  Context as LambdaContext,
  DynamoDBBatchResponse,
  DynamoDBStreamEvent,
} from "aws-lambda";
import * as Effect from "effect/Effect";
import { declare, type From } from "../../policy.ts";
import * as Lambda from "./function.ts";
import type { AnyTable } from "../dynamodb/table.ts";
import type { Consume, TableEvent } from "../dynamodb/table.consume.ts";
import {
  TableEventSource,
  type TableEventSourceProps,
} from "../dynamodb/table.event-source.ts";

export const consumeTable =
  <T extends AnyTable, ID extends string, Req>(
    id: ID,
    {
      table,
      handle,
      ...eventSourceProps
    }: {
      table: T;
      handle: (
        event: TableEvent<InstanceType<T["props"]["items"]>>,
        context: LambdaContext,
      ) => Effect.Effect<DynamoDBBatchResponse | void, never, Req>;
    } & TableEventSourceProps,
  ) =>
  <const Props extends Lambda.FunctionProps<Req>>({
    bindings,
    ...props
  }: Props) =>
    Lambda.Function(id, {
      handle: Effect.fn(function* (
        event: DynamoDBStreamEvent,
        context: LambdaContext,
      ) {
        yield* declare<Consume<From<T>>>();

        // Pass the event directly to the handler
        // The DynamoDB stream records contain dynamodb.NewImage and dynamodb.OldImage
        // which are already in the correct format (AttributeValue maps)
        // The user's handle function receives typed records based on the table's items type
        const response = yield* handle(
          event as unknown as TableEvent<InstanceType<T["props"]["items"]>>,
          context,
        );

        return {
          batchItemFailures: response?.batchItemFailures ?? [],
        } satisfies DynamoDBBatchResponse;
      }),
    })({
      ...props,
      bindings: bindings.and(TableEventSource(table, eventSourceProps)),
    });
