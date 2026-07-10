import type * as Lambda from "@distilled.cloud/aws/lambda";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Binding from "../../Binding.ts";
import type { ServerlessCluster } from "./ServerlessCluster.ts";

export type MSKRecord = import("aws-lambda").MSKRecord;

export interface KafkaEventSourceProps {
  /**
   * The Kafka topic name(s) the function consumes. At least one is required.
   */
  topics: string[];
  /**
   * The Kafka consumer group id used by the event source poller.
   * @default a Lambda-generated id
   */
  consumerGroupId?: string;
  /**
   * The position in the topic from which the poller starts reading.
   * @default "LATEST"
   */
  startingPosition?: "TRIM_HORIZON" | "LATEST";
  /**
   * The maximum number of records in each batch that Lambda pulls from the topic.
   * @default 100
   */
  batchSize?: number;
  /**
   * The maximum amount of time, in seconds, that Lambda spends gathering
   * records before invoking the function.
   * @default 500ms (0)
   */
  maximumBatchingWindowInSeconds?: number;
  /**
   * Whether the event source mapping actively polls.
   * @default true
   */
  enabled?: boolean;
  /**
   * Filter criteria to control which records are sent to the function.
   */
  filterCriteria?: Lambda.FilterCriteria;
  /**
   * Provisioned poller configuration for predictable throughput.
   */
  provisionedPollerConfig?: Lambda.ProvisionedPollerConfig;
}

/** @binding */
export interface KafkaEventSource extends Binding.Service<
  KafkaEventSource,
  "AWS.Kafka.KafkaEventSource",
  KafkaEventSourceService
> {}

export const KafkaEventSource = Binding.Service<KafkaEventSource>(
  "AWS.Kafka.KafkaEventSource",
);

export type KafkaEventSourceService = <StreamReq = never, Req = never>(
  cluster: ServerlessCluster,
  props: KafkaEventSourceProps,
  process: (
    stream: Stream.Stream<MSKRecord, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) => Effect.Effect<void, never, never>;

/**
 * Subscribe a runtime to records from one or more topics on an MSK
 * {@link ServerlessCluster}.
 *
 * The Lambda runtime implementation grants the IAM actions MSK IAM
 * authentication requires, creates an event source mapping pointing at the
 * cluster, and forwards matching `aws:kafka` records into the supplied
 * `Stream`.
 */
export const consumeKafkaTopic = <
  C extends ServerlessCluster,
  Req = never,
  StreamReq = never,
>(
  cluster: C,
  props: KafkaEventSourceProps,
  process: (
    stream: Stream.Stream<MSKRecord, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) => KafkaEventSource.use((source) => source(cluster, props, process));
