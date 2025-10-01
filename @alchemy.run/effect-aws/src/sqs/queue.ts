import type * as lambda from "aws-lambda";

import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as S from "effect/Schema";

import type { Resource } from "@alchemy.run/effect";
import { consume, type Consume } from "./queue.consumer.ts";
import { QueueProvider } from "./queue.provider.ts";

// required to avoid this error in consumers: "The inferred type of 'Messages' cannot be named without a reference to '../../effect-aws/node_modules/@types/aws-lambda'. This is likely not portable. A type annotation is necessary.ts(2742)"
export type * as lambda from "aws-lambda";

export type QueueType = typeof QueueType;
export const QueueType = "AWS::SQS::Queue";

export type QueueProps<Msg = any> = {
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

export type QueueAttributes<ID extends string, P extends QueueProps> = {
  type: typeof QueueType;
  id: ID;
  queueName: P["queueName"] extends string ? P["queueName"] : string;
  queueUrl: string;
  queueArn: string;
};

export type Queue<
  ID extends string = string,
  P extends QueueProps = QueueProps,
> = Resource<
  typeof QueueType,
  ID,
  P,
  QueueAttributes<ID, P>,
  typeof QueueProvider
>;

export const Queue = <ID extends string, P extends QueueProps>(
  id: ID,
  props: P,
) =>
  Object.assign(Context.Tag(id)<P, QueueAttributes<ID, P>>(), {
    kind: "Resource",
    type: QueueType,
    id,
    props,
    provider: QueueProvider,
    // phantom
    attributes: undefined! as QueueAttributes<ID, P>,
    consume<Self, const ID extends string, Err, Req>(
      this: Self,
      id: ID,
      handler: (
        event: lambda.SQSEvent,
        context: lambda.Context,
      ) => Effect.Effect<
        lambda.SQSBatchResponse | void,
        Err,
        Req | Consume<Extract<Self, Queue>>
      >,
    ) {
      return consume(this as Extract<Self, Queue>, id, handler);
    },
  } as const);
