import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Binding from "../../Binding.ts";
import type { Topic } from "./Topic.ts";

/** @binding */
export interface TopicSink extends Binding.Service<
  TopicSink,
  "AWS.SNS.TopicSink",
  (
    topic: Topic,
  ) => Effect.Effect<Sink.Sink<void, string, readonly string[], never>>
> {}

export const TopicSink = Binding.Service<TopicSink>("AWS.SNS.TopicSink");
