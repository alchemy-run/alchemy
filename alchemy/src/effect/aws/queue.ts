import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as S from "effect/Schema";

type Props<Msg = any> = {
  fifo?: boolean;
  message: S.Schema<Msg>;
};

type Attributes<ID extends string> = {
  type: "AWS::SQS::Queue";
  id: ID;
  queueName: string;
  queueArn: string;
  queueUrl: string;
};

type Queue<ID extends string, P extends Props> = Context.TagClass<
  P,
  ID,
  Attributes<ID>
>;

export const Tag = <ID extends string, P extends Props>(id: ID, props: P) =>
  Object.assign(Context.Tag(id)<P, Attributes<ID>>(), props);

export const send = <Q extends Queue<any, any>>(queue: Q, message: any) =>
  Effect.gen(function* () {
    //
  });

export const consume = <Q extends Queue<any, any>>(
  queue: Q,
  consumer: (batch: any) => Effect.Effect<any>,
) =>
  Effect.gen(function* () {
    const q = yield* queue;
  });
