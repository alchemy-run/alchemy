import type {
  Context as LambdaContext,
  SQSBatchResponse,
  SQSEvent,
} from "aws-lambda";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as S from "effect/Schema";
import { SQS as SQSClient } from "itty-aws/sqs";
import { App } from "../app.ts";
import { allow, type Allow } from "../policy.ts";
import type { Provider as ResourceProvider } from "../provider.ts";
import type { Resource } from "../resource.ts";
import type { TagInstance } from "../util.ts";
import * as Account from "./account.ts";
import { createAWSServiceClientLayer } from "./client.ts";
import * as Credentials from "./credentials.ts";
import type * as Lambda from "./function.ts";
import * as Region from "./region.ts";

export type Type = typeof Type;
export const Type = "AWS::SQS::Queue";

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
  type: typeof Type;
  id: ID;
  queueName: P["queueName"] extends string ? P["queueName"] : string;
  queueUrl: string;
  queueArn: string;
};

type Queue<ID extends string = string, P extends Props = Props> = Resource<
  typeof Type,
  ID,
  P,
  Attributes<ID, P>,
  typeof QueueProvider
> & {
  new (_: never): TagInstance<Context.TagClass<P, ID, Attributes<ID, P>>>;
};

export const Tag = <ID extends string, P extends Props>(id: ID, props: P) =>
  Object.assign(Context.Tag(id)<P, Attributes<ID, P>>(), {
    type: Type,
    id,
    props,
    provider: QueueProvider,
    // phantom
    attributes: undefined! as Attributes<ID, P>,
    consume<Self, Err, Req>(
      this: Self,
      consumer: (
        event: SQSEvent,
        context: LambdaContext,
      ) => Effect.Effect<SQSBatchResponse | void, Err, Req>,
    ) {
      return consume(this, consumer);
    },
  } as const);

export const consume = <Q, Err, Req>(
  queue: Q,
  handler: (
    event: SQSEvent,
    context: LambdaContext,
  ) => Effect.Effect<SQSBatchResponse | void, Err, Req>,
): Consumer<Q, Err, Req> => {
  const iae = Effect.gen(function* () {
    return handler;
  });
  return Object.assign(iae, {
    self: queue,
  });
};

export type Consumer<Q, Err, Req> = Effect.Effect<
  (
    request: SQSEvent,
    context: LambdaContext,
  ) => Effect.Effect<SQSBatchResponse | void, Err, Req>,
  Err,
  Req | Consume<Extract<Q, Queue>>
> & {
  self: Q;
};

export type Consume<Q extends Queue = Queue> = Lambda.Bindable<
  Allow<"sqs:Consume", Q>
>;

export const Consume = <Q extends Queue>(queue: Q): Consume<Q> => ({
  effect: "Allow",
  action: "sqs:Consume",
  resource: queue,
  bind: Effect.fn(function* (_func, action, { queueUrl, queueArn }) {
    return {
      policyStatements: [
        {
          Effect: "Allow",
          Action: [
            "sqs:ReceiveMessage",
            "sqs:DeleteMessage",
            "sqs:GetQueueAttributes",
            "sqs:GetQueueUrl",
            "sqs:ChangeMessageVisibility",
          ],
          Resource: queueArn,
        },
      ],
    };
  }),
});

export type SendMessage<Q extends Queue = Queue> = Lambda.Bindable<
  Allow<"sqs:SendMessage", Q>
>;

export const SendMessage = <Q extends Queue>(queue: Q): SendMessage<Q> => ({
  effect: "Allow",
  action: "sqs:SendMessage",
  resource: queue,
  bind: Effect.fn(function* (_func, action, { queueUrl }) {
    const key = `${queue.id.toUpperCase().replace(/-/g, "_")}_QUEUE_URL`;
    return {
      env: {
        [key]: queueUrl,
      },
      policyStatements: [
        {
          Sid: action.stmt.sid,
          Effect: "Allow",
          Action: ["sqs:SendMessage"],
          Resource: [queueUrl],
        },
      ],
      bundle: {
        plugins: [{}],
      },
    };
  }),
});

export const send = <Q extends Queue<string, Props>>(
  queue: Q,
  message: Q["props"]["message"]["Type"],
) =>
  Effect.gen(function* () {
    // TODO(sam): we want this to be a phantom and not explicitly in the Requirements
    yield* allow<SendMessage<Q>>();
    const sqs = yield* QueueClient;
    const url =
      process.env[`${queue.id.toUpperCase().replace(/-/g, "_")}_QUEUE_URL`]!;
    return yield* sqs.sendMessage({
      QueueUrl: url,
      MessageBody: JSON.stringify(message),
    });
  });

export class QueueClient extends Context.Tag("AWS::SQS::Queue.Client")<
  QueueClient,
  SQSClient
>() {}

export const client = createAWSServiceClientLayer<
  typeof QueueClient,
  SQSClient
>(QueueClient, SQSClient);

export const clientFromEnv = Layer.provide(
  client,
  Layer.merge(Credentials.fromEnv, Region.fromEnv),
);

export class QueueProvider extends Context.Tag("AWS::SQS::Queue")<
  QueueProvider,
  ResourceProvider<"AWS::SQS::Queue", Props, Attributes<string, Props>>
>() {}

export const provider = Layer.effect(
  QueueProvider,
  Effect.gen(function* () {
    const sqs = yield* QueueClient;
    const app = yield* App;
    const region = yield* Region.Region;
    const accountId = yield* Account.AccountID;
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
      type: Type,
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
        const queueArn = `arn:aws:sqs:${region}:${accountId}:${queueName}`;
        return {
          id,
          type: Type,
          queueName,
          queueUrl: response.QueueUrl!,
          queueArn: queueArn,
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
    } satisfies ResourceProvider<Type, Props, Attributes<string, Props>>;
  }),
);
