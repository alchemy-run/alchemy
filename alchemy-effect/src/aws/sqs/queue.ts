import type * as S from "effect/Schema";

import { Resource } from "alchemy-effect";

// required to avoid this error in consumers: "The inferred type of 'Messages' cannot be named without a reference to '../../effect-aws/node_modules/@types/aws-lambda'. This is likely not portable. A type annotation is necessary.ts(2742)"
export type * as lambda from "aws-lambda";

export const Queue = Resource<{
  <const ID extends string, const Props extends QueueProps>(
    id: ID,
    props: Props,
  ): Queue<ID, Props>;
}>("AWS.SQS.Queue");

export interface Queue<
  ID extends string = string,
  Props extends QueueProps = QueueProps,
> extends Resource<"AWS.SQS.Queue", ID, Props, QueueAttrs<Props>> {}

export type QueueAttrs<Props extends QueueProps> = {
  queueName: Props["queueName"] extends string ? Props["queueName"] : string;
  queueUrl: Props["fifo"] extends true ? `${string}.fifo` : string;
  queueArn: `arn:aws:sqs:${string}:${string}:${Props["queueName"]}`;
};

export type QueueProps<Msg = any> = {
  /**
   * Schema for the message body.
   */
  schema: S.Schema<Msg>;
  /**
   * Name of the queue.
   * @default ${app}-${stage}-${id}?.fifo
   */
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
