import { $ } from "@/index";
import * as SQS from "@/aws/sqs";
import * as AWS from "@/aws";
import * as DynamoDB from "@/aws/dynamodb";
import * as Lambda from "@/aws/lambda";
import { apply, destroy, type } from "@/index";
import { test } from "@/test";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as S from "effect/Schema";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "..", "..", "handler.ts");

// TODO(sam): set up attest
class Table extends DynamoDB.Table("Table", {
  tableName: "test",
  items: type<{ id: string; sk: string }>,
  attributes: {
    id: S.String,
    sk: S.String,
  },
  partitionKey: "id",
  sortKey: "sk",
}) {}
class Queue extends SQS.Queue("Queue", {
  queueName: "test",
  schema: S.String,
}) {}

const func = Lambda.serve("MyFunction", {
  fetch: Effect.fn(function* (event) {
    const item = yield* DynamoDB.getItem({
      table: Table,
      key: {
        id: "id",
        sk: "sk",
      },
    }).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
    return {
      body: JSON.stringify(item?.Item),
    };
  }),
});

{
  class MyFunction extends func({
    main,
    bindings: $(
      DynamoDB.GetItem(Table, {
        leadingKeys: $.anyOf("id"),
      }),
    ),
  }) {}
}
{
  class MyFunction extends func({
    main,
    // @ts-expect-error - missing DynamoDB.GetItem(Table)
    bindings: $(),
  }) {}
}
{
  class MyFunction extends func({
    main,
    // @ts-expect-error - missing leading keys
    bindings: $(DynamoDB.GetItem(Table)),
  }) {}
}
{
  class MyFunction extends func({
    main,
    // @ts-expect-error - wrong leading key
    bindings: $(
      DynamoDB.GetItem(Table, {
        leadingKeys: $.anyOf("sk"),
      }),
    ),
  }) {}
}
{
  class MyFunction extends func({
    main,
    // @ts-expect-error - additional SQS.SendMessage(Queue)
    bindings: $(
      DynamoDB.GetItem(Table, {
        leadingKeys: $.anyOf("id"),
      }),
      SQS.SendMessage(Queue),
    ),
  }) {}
}

const MonitorSimple = <const ID extends string, Req>(
  id: ID,
  {
    onAlarm,
  }: {
    onAlarm: (message: string) => Effect.Effect<void, never, Req>;
  },
) => {
  class Messages extends SQS.Queue(`${id}-Messages`, {
    fifo: true,
    schema: S.String,
  }) {}

  return Lambda.consume(id, {
    queue: Messages,
    handle: Effect.fn(function* (event) {
      for (const record of event.Records) {
        yield* onAlarm(record.body);
      }
    }),
  });
};

const monitor = MonitorSimple("MyMonitor", {
  onAlarm: Effect.fn(function* (message) {
    yield* SQS.sendMessage(Queue, message).pipe(
      Effect.catchAll(() => Effect.void),
    );
  }),
});
{
  class MyMonitor extends monitor({
    main,
    bindings: $(SQS.SendMessage(Queue)),
  }) {}
}
{
  class MyMonitor extends monitor({
    main,
    // @ts-expect-error - missing SQS.SendMessage(Queue)
    bindings: $(),
  }) {}
}
{
  class MyMonitor extends monitor({
    main,
    // @ts-expect-error - additional DynamoDB.GetItem(Table)
    bindings: $(SQS.SendMessage(Queue), DynamoDB.GetItem(Table)),
  }) {}
}

export interface MonitorComplexProps<ReqAlarm, ReqResolved>
  extends Lambda.FunctionProps {
  onAlarm: (
    batch: SQS.QueueEvent<string>,
  ) => Effect.Effect<void, never, ReqAlarm>;
  onResolved?: (
    batch: SQS.QueueEvent<string>,
  ) => Effect.Effect<void, never, ReqResolved>;
}

const MonitorComplex = <const ID extends string, ReqAlarm, ReqResolved>(
  id: ID,
  {
    onAlarm,
    onResolved,
  }: {
    onAlarm: (
      batch: SQS.QueueEvent<string>,
    ) => Effect.Effect<void, never, ReqAlarm>;
    onResolved?: (
      batch: SQS.QueueEvent<string>,
    ) => Effect.Effect<void, never, ReqResolved>;
  },
) => {
  class Messages extends SQS.Queue(`${id}-Messages`, {
    fifo: true,
    schema: S.String,
  }) {}

  return <const Props extends Lambda.FunctionProps<ReqAlarm | ReqResolved>>({
    bindings,
    ...props
  }: Props) =>
    Lambda.consume(id, {
      queue: Messages,
      handle: Effect.fn(function* (batch) {
        yield* SQS.sendMessage(Messages, "hello").pipe(
          Effect.catchAll(() => Effect.void),
        );
        if (onAlarm) {
          yield* onAlarm(batch);
        }
        if (onResolved) {
          yield* onResolved(batch);
        }
      }),
    })({
      ...props,
      bindings: bindings.and(SQS.SendMessage(Messages)),
    });
};

// src/my-api.ts

class Outer extends SQS.Queue("Outer", {
  fifo: true,
  schema: S.String,
}) {}

const monitorComplex = MonitorComplex("MyMonitor", {
  onAlarm: Effect.fn(function* (batch) {
    for (const record of batch.Records) {
      yield* SQS.sendMessage(Outer, record.body).pipe(
        Effect.catchAll(() => Effect.void),
      );
    }
  }),
  onResolved: Effect.fn(function* (batch) {
    for (const record of batch.Records) {
      yield* SQS.sendMessage(Outer, record.body).pipe(
        Effect.catchAll(() => Effect.void),
      );
    }
  }),
});

{
  class MyMonitor extends monitorComplex({
    main,
    bindings: $(SQS.SendMessage(Outer)),
  }) {}
}
{
  class MyMonitor extends monitorComplex({
    main,
    // @ts-expect-error - missing SQS.SendMessage(Outer)
    bindings: $(),
  }) {}
}
{
  class MyMonitor extends monitorComplex({
    main,
    // @ts-expect-error - additional DynamoDB.GetItem(Table)
    bindings: $(SQS.SendMessage(Outer), DynamoDB.GetItem(Table)),
  }) {}
}
