import type * as lambda from "aws-lambda";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { Queue } from "./Queue.ts";

export type SQSRecord = lambda.SQSRecord;

export interface MessagesProps extends QueueEventSourceProps {
  /**
   * Time in seconds for long polling when using the process (run) path.
   * @default 20
   */
  waitTimeSeconds?: number;
  /**
   * Maximum number of messages to receive per poll when using the process (run) path.
   * @default 10
   */
  maxNumberOfMessages?: number;
}

type MessagesHandler<Req> = (
  stream: Stream.Stream<SQSRecord>,
) => Effect.Effect<void, never, Req>;

/**
 * Subscribe an Effect handler to messages produced by an SQS {@link Queue}.
 *
 * @param queue The SQS queue to consume messages from.
 * @param props Optional event-source configuration.
 * @param process The handler invoked with a stream of SQS records (last argument).
 */
export function consumeQueueMessages<Q extends Queue, Req = never>(
  queue: Q,
  process: MessagesHandler<Req>,
): Effect.Effect<void, never, QueueEventSource>;
export function consumeQueueMessages<Q extends Queue, Req = never>(
  queue: Q,
  props: MessagesProps,
  process: MessagesHandler<Req>,
): Effect.Effect<void, never, QueueEventSource>;
export function consumeQueueMessages<Q extends Queue, Req = never>(
  queue: Q,
  propsOrProcess: MessagesProps | MessagesHandler<Req>,
  maybeProcess?: MessagesHandler<Req>,
): Effect.Effect<void, never, QueueEventSource> {
  const [props, process] =
    typeof propsOrProcess === "function"
      ? [{} as MessagesProps, propsOrProcess]
      : [propsOrProcess, maybeProcess!];
  return QueueEventSource.use((source) => source(queue, props, process));
}

export class QueueEventSource extends Context.Service<
  QueueEventSource,
  QueueEventSourceService
>()("AWS.SQS.QueueEventSource") {}

export interface QueueEventSourceProps {
  /**
   * The maximum number of records in each batch that Lambda pulls from the queue.
   * @default 10
   */
  batchSize?: number;
  /**
   * The maximum amount of time, in seconds, that Lambda spends gathering records before invoking the function.
   * @default 0
   */
  maximumBatchingWindowInSeconds?: number;
}

export type QueueEventSourceService = <Req = never>(
  bucket: Queue,
  props: MessagesProps,
  process: (
    stream: Stream.Stream<SQSRecord>,
  ) => Effect.Effect<void, never, Req>,
) => Effect.Effect<void, never, never>;
