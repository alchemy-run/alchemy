import type * as lambda from "aws-lambda";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Binding from "../../Binding.ts";
import type { Topic } from "./Topic.ts";

export type TopicNotification = lambda.SNSMessage;

export interface TopicEventSourceProps {
  /**
   * Raw SNS subscription attributes for the Lambda subscription, such as
   * `FilterPolicy` or `RedrivePolicy`.
   */
  attributes?: Record<string, string>;
}

/** @binding */
export interface TopicEventSource extends Binding.Service<
  TopicEventSource,
  "AWS.SNS.TopicEventSource",
  TopicEventSourceService
> {}
export const TopicEventSource = Binding.Service<TopicEventSource>(
  "AWS.SNS.TopicEventSource",
);

export type TopicEventSourceService = <StreamReq = never, Req = never>(
  topic: Topic,
  props: TopicEventSourceProps,
  process: (
    stream: Stream.Stream<TopicNotification, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) => Effect.Effect<void, never, never>;

type TopicEventSourceHandler<Req, StreamReq> = (
  stream: Stream.Stream<TopicNotification, never, StreamReq>,
) => Effect.Effect<void, never, Req>;

export function notifications<T extends Topic, Req = never, StreamReq = never>(
  topic: T,
  process: TopicEventSourceHandler<Req, StreamReq>,
): Effect.Effect<void, never, TopicEventSource>;
export function notifications<T extends Topic, Req = never, StreamReq = never>(
  topic: T,
  props: TopicEventSourceProps,
  process: TopicEventSourceHandler<Req, StreamReq>,
): Effect.Effect<void, never, TopicEventSource>;
export function notifications<T extends Topic, Req = never, StreamReq = never>(
  topic: T,
  propsOrProcess:
    | TopicEventSourceProps
    | TopicEventSourceHandler<Req, StreamReq>,
  maybeProcess?: TopicEventSourceHandler<Req, StreamReq>,
) {
  const [props, process] =
    typeof propsOrProcess === "function"
      ? [{} as TopicEventSourceProps, propsOrProcess]
      : [propsOrProcess, maybeProcess!];
  return TopicEventSource.use((source) => source(topic, props, process));
}
