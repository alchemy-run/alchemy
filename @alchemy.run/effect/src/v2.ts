import * as Effect from "effect/Effect";
import type * as HKT from "effect/HKT";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import { Binding, type BindingLike } from "./binding.ts";
import { Host } from "./host.ts";
import { Resource, type InstanceOf } from "./resource.ts";
import { Service } from "./service.ts";

// AWS Lambda Function (Host)
export type Lambda<Binding extends BindingLike> = Host<
  "AWS.Lambda.Function",
  Binding,
  {
    env: Record<string, string>;
    policyStatements: any[];
  }
>;
export const Lambda = <B extends BindingLike>(binding: B): Lambda<B> =>
  Host("AWS.Lambda.Function", binding);

// Cloudflare Worker (Host)
export type Worker<Binding extends BindingLike> = Host<
  "Cloudflare.Worker",
  Binding,
  {
    bindings: {
      [key: string]: any;
    };
  }
>;

export const Worker = <Binding extends BindingLike>(
  binding: Binding,
): Worker<Binding> => Host("Cloudflare.Worker", binding);

// SQS Queue (Resource)
export declare namespace Queue {
  export type Props<Message = any> = {
    fifo?: boolean;
    schema: S.Schema<Message>;
  };
  export type Attr<
    ID extends string,
    Props extends Queue.Props = Queue.Props,
  > = {
    id: ID;
    queueUrl: Props["fifo"] extends true ? `${string}.fifo` : string;
  };
  export type Instance<
    ID extends string = string,
    Props extends Queue.Props = Queue.Props,
  > = Resource<"AWS.SQS.Queue", ID, Props, Queue.Attr<ID, Props>>;
}
export type Queue<
  ID extends string = string,
  Props extends Queue.Props = Queue.Props,
> = Queue.Instance<ID, Props> &
  (<const ID extends string, Props extends Queue.Props>(
    id: ID,
    props: Props,
  ) => Queue<ID, Props>);
export const Queue = Resource("AWS.SQS.Queue")<Queue>();

// Consume (Binding)
export type Consume<Q = Queue.Instance> = Binding<
  "AWS::SQS::Consume",
  Extract<Q, Queue.Instance>
> &
  (<Q>(queue: Q) => Consume<InstanceOf<Q>>);
export const Consume = ((queue: Queue.Instance) =>
  Binding("AWS::SQS::Consume", queue)) as Consume<Queue>;

// SendMessage (Binding)
export type SendMessage<Q = Queue.Instance> = Binding<
  "AWS::SQS::SendMessage",
  Extract<Q, Queue.Instance>
> &
  (<Q>(queue: Q) => SendMessage<InstanceOf<Q>>);
export const SendMessage = ((queue: Queue.Instance) =>
  Binding("AWS::SQS::SendMessage", queue)) as SendMessage<Queue>;

// example resource
class Messages extends Queue("messages", {
  fifo: true,
  schema: S.Struct({
    id: S.Int,
    value: S.String,
  }),
}) {}

const _Messages = Queue("messages", {
  fifo: true,
  schema: S.Struct({
    id: S.Int,
    value: S.String,
  }),
});

const __L = Lambda(Consume);
const __c = Consume(Messages);
const _tag = SendMessage(Messages);
const __tag = SendMessage(_Messages);

export const queueProvider = Layer.effect(
  Provider(Queue),
  Effect.gen(function* () {
    return {
      read: Effect.fn(function* ({ id, olds, output }) {
        return output;
      }),
    };
  }),
);

// bind a Queue to an AWS Lambda function
export const lambdaQueueEventSource = Layer.effect(
  Lambda(Consume),
  Effect.gen(function* () {
    return {
      attach: Effect.fn(function* ({ queueUrl }) {
        return {
          env: {
            QUEUE_URL: queueUrl,
          },
        };
      }),
    };
  }),
);

// bind a Queue to a Cloudflare Worker
export const lambdaQueueCloudflareBinding = Layer.effect(
  Worker(Consume),
  Effect.gen(function* () {
    return {
      attach: Effect.fn(function* ({ queueUrl }) {
        return {
          bindings: {
            QUEUE: queueUrl,
          },
        };
      }),
    };
  }),
);

export const lambdaSendMessage = Layer.effect(
  Lambda(SendMessage),
  Effect.gen(function* () {
    return {
      attach: Effect.fn(function* ({ queueUrl }) {
        return {
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["sqs:SendMessage"],
              Resource: [queueUrl],
            },
          ],
          env: {
            QUEUE_URL: queueUrl,
          },
        };
      }),
    };
  }),
);

export const serve = Service<(req: Request) => Effect.Effect<Response, any>>();

const echo = serve(
  "echo",
  Effect.fn(function* (req) {
    return new Response(req.body, req);
  }),
);

// const _tag: typeof tag = "AWS::SQS::SendMessage(messages)";

export interface FlatMap<F extends HKT.TypeLambda> extends HKT.TypeClass<F> {
  readonly flatMap: {
    <A, R2, O2, E2, B>(
      f: (a: A) => HKT.Kind<F, R2, O2, E2, B>,
    ): <R1, O1, E1>(
      self: HKT.Kind<F, R1, O1, E1, A>,
    ) => HKT.Kind<F, R1 & R2, O1 | O2, E1 | E2, B>;
    <R1, O1, E1, A, R2, O2, E2, B>(
      self: HKT.Kind<F, R1, O1, E1, A>,
      f: (a: A) => HKT.Kind<F, R2, O2, E2, B>,
    ): HKT.Kind<F, R1 & R2, O1 | O2, E1 | E2, B>;
  };
}
