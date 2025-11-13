import { $ } from "alchemy-effect";
import * as Lambda from "alchemy-effect/aws/lambda";
import * as SQS from "alchemy-effect/aws/sqs";
import * as Effect from "effect/Effect";
import * as S from "effect/Schema";

class Message extends S.Class<Message>("Message")({
  id: S.Int,
  value: S.String,
}) {}

const MonitorSimple = <const ID extends string, Req>(
  id: ID,
  {
    onAlarm,
  }: {
    onAlarm: (message: Message) => Effect.Effect<void, never, Req>;
  },
) => {
  class Messages extends SQS.Queue(`${id}-Messages`, {
    fifo: true,
    schema: Message,
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

class Outer extends SQS.Queue("Outer", {
  fifo: true,
  schema: Message,
}) {}

export class MySimpleMonitor extends MonitorSimple("MyMonitor", {
  onAlarm: Effect.fn(function* (message) {
    yield* SQS.sendMessage(Outer, message).pipe(
      Effect.catchAll(() => Effect.void),
    );
  }),
})({
  main: import.meta.filename,
  bindings: $(SQS.SendMessage(Outer)),
}) {}

// src/my-component.ts
export interface MonitorComplexProps<ReqAlarm, ReqResolved>
  extends Lambda.FunctionProps {
  onAlarm: (
    batch: SQS.QueueEvent<Message>,
  ) => Effect.Effect<void, never, ReqAlarm>;
  onResolved?: (
    batch: SQS.QueueEvent<Message>,
  ) => Effect.Effect<void, never, ReqResolved>;
}

const MonitorComplex = <const ID extends string, ReqAlarm, ReqResolved>(
  id: ID,
  {
    onAlarm,
    onResolved,
  }: {
    onAlarm: (
      batch: SQS.QueueEvent<Message>,
    ) => Effect.Effect<void, never, ReqAlarm>;
    onResolved?: (
      batch: SQS.QueueEvent<Message>,
    ) => Effect.Effect<void, never, ReqResolved>;
  },
) => {
  class Messages extends SQS.Queue(`${id}-Messages`, {
    fifo: true,
    schema: Message,
  }) {}

  return <const Props extends Lambda.FunctionProps<ReqAlarm | ReqResolved>>({
    bindings,
    ...props
  }: Props) =>
    Lambda.consume(id, {
      queue: Messages,
      handle: Effect.fn(function* (batch) {
        yield* SQS.sendMessage(Messages, {
          id: 1,
          value: "1",
        }).pipe(Effect.catchAll(() => Effect.void));
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

export class MyMonitor extends MonitorComplex("MyMonitor", {
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
})({
  main: import.meta.filename,
  bindings: $(SQS.SendMessage(Outer)),
}) {}

// export default MyMonitor.pipe(
//   Effect.provide(SQS.clientFromEnv()),
//   Lambda.toHandler,
// );
