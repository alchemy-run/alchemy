import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as S from "effect/Schema";
import { SQS as SQSClient } from "itty-aws/sqs";
import { App } from "../app.ts";
import { allow, type Allow } from "../policy.ts";
import type { Provider as ResourceProvider } from "../provider.ts";
import { createAWSServiceClientLayer } from "./client.ts";
import * as Credentials from "./credentials.ts";
import * as Region from "./region.ts";

type Props<Msg = any> = {
  message: S.Schema<Msg>;
  queueName?: string;
  /**
   * Delay in seconds for all messages in the queue (`0` - `900`).
   * @default 0
   */
  delaySeconds?: number;
  /**
   * Maximum message size in bytes (`1,024` - `1,048,576`).
   * @default 1048576
   */
  maximumMessageSize?: number;
  /**
   * Message retention period in seconds (`60` - `1,209,600`).
   * @default 345600
   */
  messageRetentionPeriod?: number;
  /**
   * Time in seconds for `ReceiveMessage` to wait for a message (`0` - `20`).
   * @default 0
   */
  receiveMessageWaitTimeSeconds?: number;
  /**
   * Visibility timeout in seconds (`0` - `43,200`).
   * @default 30
   */
  visibilityTimeout?: number;
} & (
  | {
      fifo?: false;
      contentBasedDeduplication?: undefined;
      deduplicationScope?: undefined;
      fifoThroughputLimit?: undefined;
    }
  | {
      fifo: true;
      /**
       * Enables content-based deduplication for FIFO queues. Only valid when `fifo` is `true`.
       * @default false
       */
      contentBasedDeduplication?: boolean;
      /**
       * Specifies whether message deduplication occurs at the message group or queue level.
       * Valid values are `messageGroup` and `queue`. Only valid when `fifo` is `true`.
       */
      deduplicationScope?: "messageGroup" | "queue";
      /**
       * Specifies whether the FIFO queue throughput quota applies to the entire queue or per message group.
       * Valid values are `perQueue` and `perMessageGroupId`. Only valid when `fifo` is `true`.
       */
      fifoThroughputLimit?: "perQueue" | "perMessageGroupId";
    }
);

type Attributes<ID extends string, P extends Props> = {
  type: "AWS::SQS::Queue";
  id: ID;
  queueName: P["queueName"] extends string ? P["queueName"] : string;
  queueUrl: string;
};

type Queue<ID extends string = string, P extends Props = Props> = {
  id: ID;
  props: P;
  provider: typeof Provider;
};

type Message<Q extends Queue> = Q["props"]["message"]["Type"];

export const Tag = <ID extends string, P extends Props>(id: ID, props: P) =>
  Object.assign(Context.Tag(id)<P, Attributes<ID, P>>(), {
    id,
    props,
    provider: Provider,
  });

export declare const url: <Q extends Queue>(
  queue: Q,
) => Effect.Effect<string, never, never>;

export const consume = <Q extends Queue>(
  queue: Q,
  consumer: (batch: any) => Effect.Effect<any>,
) => Effect.gen(function* () {});

export type SendMessage<Q extends Queue> = Allow<"sqs:SendMessage", Q>;

export declare const SendMessage: <Q extends Queue>(queue: Q) => SendMessage<Q>;

export const send = <Q extends Queue<string, Props>>(
  queue: Q,
  message: Message<Q>,
) =>
  Effect.gen(function* () {
    // TODO(sam): we want this to be a phantom and not explicitly in the Requirements
    yield* allow<SendMessage<Q>>();
    const sqs = yield* Client;
    return yield* sqs.sendMessage({
      QueueUrl: yield* url(queue),
      MessageBody: JSON.stringify(message),
    });
  });

export class Client extends Context.Tag("AWS::Lambda")<Client, SQSClient>() {}

export const client = createAWSServiceClientLayer(Client, SQSClient);

export const clientFromEnv = Layer.provide(
  client,
  Layer.merge(Credentials.fromEnv, Region.fromEnv),
);

export class Provider extends Context.Tag("AWS::Lambda::Lifecycle")<
  Provider,
  ResourceProvider<Props, Attributes<string, Props>>
>() {}

export const provider = Layer.effect(
  Provider,
  Effect.gen(function* () {
    const sqs = yield* Client;
    const app = yield* App;
    const createQueueName = (id: string, props: Props) =>
      props.queueName ??
      `${app.name}-${id}-${app.stage}${props.fifo ? ".fifo" : ""}`;
    const createAttributes = (props: Props) => ({
      FifoQueue: props.fifo ? "true" : "false",
      FifoThroughputLimit: props.fifoThroughputLimit,
      ContentBasedDeduplication: props.contentBasedDeduplication
        ? "true"
        : "false",
      DeduplicationScope: props.deduplicationScope,
      DelaySeconds: props.delaySeconds?.toString(),
      MaximumMessageSize: props.maximumMessageSize?.toString(),
      MessageRetentionPeriod: props.messageRetentionPeriod?.toString(),
      ReceiveMessageWaitTimeSeconds:
        props.receiveMessageWaitTimeSeconds?.toString(),
      VisibilityTimeout: props.visibilityTimeout?.toString(),
    });
    return {
      diff: Effect.fn(function* ({ id, news, olds }) {
        const oldFifo = olds.fifo ?? false;
        const newFifo = news.fifo ?? false;
        if (oldFifo !== newFifo) {
          return { action: "replace" };
        }
        const oldQueueName = createQueueName(id, olds);
        const newQueueName = createQueueName(id, news);
        if (oldQueueName !== newQueueName) {
          return { action: "replace" };
        }
        return { action: "noop" };
      }),
      create: Effect.fn(function* ({ id, news }) {
        const queueName = createQueueName(id, news);
        const response = yield* sqs.createQueue({
          QueueName: queueName,
          Attributes: createAttributes(news),
        });
        return {
          id,
          type: "AWS::SQS::Queue",
          queueName,
          queueUrl: response.QueueUrl!,
        };
      }),
      update: Effect.fn(function* ({ news, output }) {
        yield* sqs.setQueueAttributes({
          QueueUrl: output.queueUrl,
          Attributes: createAttributes(news),
        });
        return output;
      }),
      delete: Effect.fn(function* (input) {
        yield* sqs
          .deleteQueue({
            QueueUrl: input.output.queueUrl,
          })
          .pipe(Effect.catchTag("QueueDoesNotExist", () => Effect.void));
      }),
    } satisfies ResourceProvider<Props, Attributes<string, Props>>;
  }),
);
