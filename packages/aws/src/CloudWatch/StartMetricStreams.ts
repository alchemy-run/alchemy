import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeCloudWatchResourceSetHttpBinding } from "./BindingHttp.ts";
import type { MetricStream } from "./MetricStream.ts";

type MetricStreams = [MetricStream, ...MetricStream[]];

/**
 * Runtime binding for `cloudwatch:StartMetricStreams` — resume streaming
 * for the bound metric streams after they were paused with
 * {@link StopMetricStreams}. Bind it to one or more {@link MetricStream}
 * resources; the stream names are injected automatically.
 *
 * Provide `CloudWatch.StartMetricStreamsHttp` on the hosting Lambda
 * Function to satisfy the requirement.
 * ### Managing Metric Streams
 * **Example:** Resume a Paused Metric Stream
 * ```typescript
 * // init — grants cloudwatch:StartMetricStreams on the stream
 * const startMetricStreams = yield* AWS.CloudWatch.StartMetricStreams(stream);
 *
 * // runtime
 * yield* startMetricStreams();
 * ```
 *
 * @binding
 */
export interface StartMetricStreams extends Binding.Service<
  StartMetricStreams,
  "AWS.CloudWatch.StartMetricStreams",
  (
    ...streams: MetricStreams
  ) => Effect.Effect<() => Effect.Effect<cloudwatch.StartMetricStreamsOutput, any>>
> {}

export const StartMetricStreams = Binding.Service<StartMetricStreams>(
  "AWS.CloudWatch.StartMetricStreams",
);

export const StartMetricStreamsHttp = Layer.effect(
  StartMetricStreams,
  makeCloudWatchResourceSetHttpBinding({
    tag: "AWS.CloudWatch.StartMetricStreams",
    operation: cloudwatch.startMetricStreams,
    action: "cloudwatch:StartMetricStreams",
    namesKey: "Names",
    name: (metricStream: MetricStream) => metricStream.metricStreamName,
    arn: (metricStream: MetricStream) => metricStream.metricStreamArn,
  }),
);
