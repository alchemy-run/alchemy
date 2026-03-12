import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { Resource } from "../../Resource.ts";
import {
  detectorIdentity,
  matchesDetectorIdentity,
  retryConcurrent,
} from "./common.ts";

export interface AnomalyDetectorProps
  extends cloudwatch.PutAnomalyDetectorInput {}

export interface AnomalyDetector extends Resource<
  "AWS.CloudWatch.AnomalyDetector",
  AnomalyDetectorProps,
  {
    detectorId: string;
    anomalyDetector: cloudwatch.AnomalyDetector;
  }
> {}

/**
 * A CloudWatch anomaly detector.
 *
 * @section Creating Detectors
 * @example Single Metric Detector
 * ```typescript
 * const detector = yield* AnomalyDetector("ErrorsDetector", {
 *   Namespace: "AWS/Lambda",
 *   MetricName: "Errors",
 *   Stat: "Sum",
 * });
 * ```
 */
export const AnomalyDetector = Resource<AnomalyDetector>(
  "AWS.CloudWatch.AnomalyDetector",
);

const toDescribeRequest = (
  input: cloudwatch.PutAnomalyDetectorInput,
): cloudwatch.DescribeAnomalyDetectorsInput => {
  if (input.MetricMathAnomalyDetector) {
    return {
      AnomalyDetectorTypes: ["METRIC_MATH"],
    };
  }

  return {
    Namespace: input.Namespace,
    MetricName: input.MetricName,
    Dimensions: input.Dimensions,
    AnomalyDetectorTypes: ["SINGLE_METRIC"],
  };
};

const toDeleteRequest = (
  input: Pick<
    cloudwatch.AnomalyDetector,
    | "Namespace"
    | "MetricName"
    | "Dimensions"
    | "Stat"
    | "SingleMetricAnomalyDetector"
    | "MetricMathAnomalyDetector"
  >,
): cloudwatch.DeleteAnomalyDetectorInput => ({
  Namespace: input.Namespace,
  MetricName: input.MetricName,
  Dimensions: input.Dimensions,
  Stat: input.Stat,
  SingleMetricAnomalyDetector: input.SingleMetricAnomalyDetector,
  MetricMathAnomalyDetector: input.MetricMathAnomalyDetector,
});

export const AnomalyDetectorProvider = () =>
  AnomalyDetector.provider.succeed({
    stables: ["detectorId"],
    diff: Effect.fn(function* ({ olds = {}, news = {} }) {
      if (detectorIdentity(olds) !== detectorIdentity(news)) {
        return { action: "replace" } as const;
      }
    }),
    read: Effect.fn(function* ({ olds, output }) {
      const props = output?.anomalyDetector ?? olds;
      if (!props) {
        return undefined;
      }

      const detector = yield* cloudwatch.describeAnomalyDetectors
        .items(toDescribeRequest(props))
        .pipe(
          Stream.filter((candidate) =>
            matchesDetectorIdentity(candidate, props),
          ),
          Stream.runHead,
          Effect.map(Option.getOrUndefined),
        );

      if (!detector) {
        return undefined;
      }

      return {
        detectorId: detectorIdentity(props),
        anomalyDetector: detector,
      };
    }),
    create: Effect.fn(function* ({ news, session }) {
      yield* retryConcurrent(cloudwatch.putAnomalyDetector(news));
      const detectorId = detectorIdentity(news);
      yield* session.note(detectorId);

      const state = yield* cloudwatch.describeAnomalyDetectors
        .items(toDescribeRequest(news))
        .pipe(
          Stream.filter((candidate) =>
            matchesDetectorIdentity(candidate, news),
          ),
          Stream.runHead,
          Effect.map(Option.getOrUndefined),
        );

      if (!state) {
        return yield* Effect.fail(
          new Error(`failed to read created anomaly detector '${detectorId}'`),
        );
      }

      return {
        detectorId,
        anomalyDetector: state,
      };
    }),
    update: Effect.fn(function* ({ news, session }) {
      yield* retryConcurrent(cloudwatch.putAnomalyDetector(news));
      const detectorId = detectorIdentity(news);
      yield* session.note(detectorId);

      const state = yield* cloudwatch.describeAnomalyDetectors
        .items(toDescribeRequest(news))
        .pipe(
          Stream.filter((candidate) =>
            matchesDetectorIdentity(candidate, news),
          ),
          Stream.runHead,
          Effect.map(Option.getOrUndefined),
        );

      if (!state) {
        return yield* Effect.fail(
          new Error(`failed to read updated anomaly detector '${detectorId}'`),
        );
      }

      return {
        detectorId,
        anomalyDetector: state,
      };
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* retryConcurrent(
        cloudwatch.deleteAnomalyDetector(
          toDeleteRequest(output.anomalyDetector),
        ),
      ).pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void));
    }),
  });
