import type * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Binding from "alchemy/Binding";
import { type BatchRetryExhaustedError, makeBatchedSink } from "alchemy/Util/BatchedSink";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Sink from "effect/Sink";
import * as AWSBindings from "../AWSBindings.ts";
import { PutMetricData } from "./PutMetricData.ts";

/**
 * A raw `MetricDatum` as accepted by `PutMetricData`. Callers stay in control
 * of `MetricName`, `Dimensions`, `Timestamp`, `Value`/`Values`/`Counts`,
 * `StatisticValues`, `Unit` and `StorageResolution` — no auto-marshalling.
 */
export type MetricSinkDatum = cloudwatch.MetricDatum;

export interface MetricSinkProps {
  /**
   * The CloudWatch namespace every datum is published under
   * (e.g. `"MyApp/Payments"`). Must not start with `AWS/`.
   */
  readonly Namespace: string;
}

export type MetricSinkError =
  | cloudwatch.PutMetricDataError
  | BatchRetryExhaustedError<MetricSinkDatum>;

/**
 * A batching sink over CloudWatch `PutMetricData` (1000 datums / ~1 MB per
 * call). Each upstream chunk is greedily packed into order-preserving
 * batches and sent sequentially.
 *
 * `PutMetricData` is all-or-nothing: there are no per-datum partial
 * failures, so a failed call surfaces directly on the sink's error channel
 * as the typed `PutMetricDataError` union.
 *
 * Provide `CloudWatch.MetricSinkHttp` (which itself needs
 * `CloudWatch.PutMetricDataHttp`) on the hosting Lambda Function:
 * `Effect.provide(Layer.provideMerge(AWS.CloudWatch.MetricSinkHttp, AWS.CloudWatch.PutMetricDataHttp))`.
 *
 * ### Streaming Metrics
 * **Example:** Stream Datums into CloudWatch
 * ```typescript
 * // init — grants cloudwatch:PutMetricData; all datums publish under Namespace
 * const sink = yield* AWS.CloudWatch.MetricSink({
 *   Namespace: "MyApp/Payments",
 * });
 *
 * // runtime — datums are packed into 1000-datum PutMetricData batches
 * yield* Stream.fromIterable(
 *   payments.map((payment) => ({
 *     MetricName: "PaymentProcessed",
 *     Dimensions: [{ Name: "Region", Value: payment.region }],
 *     Value: payment.amount,
 *     Unit: "Count",
 *   }) satisfies AWS.CloudWatch.MetricSinkDatum),
 * ).pipe(Stream.run(sink));
 * ```
 *
 * @binding
 */
export interface MetricSink extends Binding.Service<
  MetricSink,
  "AWS.CloudWatch.MetricSink",
  (
    props: MetricSinkProps,
  ) => Effect.Effect<Sink.Sink<void, MetricSinkDatum, readonly MetricSinkDatum[], MetricSinkError>>
> {}

export const MetricSink = Binding.Service<MetricSink>("AWS.CloudWatch.MetricSink");

const encoder = new TextEncoder();

/**
 * PutMetricData accepts up to 1 MB per POST; approximate each datum's wire
 * size by its JSON encoding and leave headroom for the request envelope
 * (`Action`, `Namespace`, form-encoding overhead).
 */
const MAX_BYTES = 1_000_000;

export const MetricSinkHttp = Layer.effect(
  MetricSink,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const putMetricData = yield* PutMetricData;

    return Effect.fn(function* (props: MetricSinkProps) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.CloudWatch.MetricSink(${props.Namespace})`({
          policyStatements: [
            {
              Effect: "Allow",
              // PutMetricData does not support resource-level permissions.
              Action: ["cloudwatch:PutMetricData"],
              Resource: ["*"],
            },
          ],
        });
      }
      const put = yield* putMetricData();
      return makeBatchedSink<
        MetricSinkDatum,
        cloudwatch.PutMetricDataResponse,
        cloudwatch.PutMetricDataError
      >({
        maxRecords: 1000,
        maxBytes: MAX_BYTES,
        sizeOf: (datum) => encoder.encode(JSON.stringify(datum)).length,
        send: (batch) =>
          put({
            Namespace: props.Namespace,
            MetricData: [...batch],
          }),
        // PutMetricData is all-or-nothing — no per-datum partial failures to
        // extract, so there is no `unprocessed`/`rejected` handling here.
      });
    });
  }),
);
