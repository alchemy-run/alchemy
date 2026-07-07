import type * as Effect from "effect/Effect";
import type * as Sink from "effect/Sink";
import * as Binding from "../../Binding.ts";
import type { Queue } from "./Queue.ts";

/** @binding */
export interface QueueSink extends Binding.Service<
  QueueSink,
  "AWS.SQS.QueueSink",
  (
    queue: Queue,
  ) => Effect.Effect<Sink.Sink<void, string, readonly string[], never>>
> {}

export const QueueSink = Binding.Service<QueueSink>("AWS.SQS.QueueSink");
