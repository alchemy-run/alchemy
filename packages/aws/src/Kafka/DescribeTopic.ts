import * as kafka from "@distilled.cloud/aws/kafka";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeKafkaClusterHttpBinding } from "./BindingHttp.ts";
import type { ServerlessCluster } from "./ServerlessCluster.ts";

/**
 * Runtime binding for the `DescribeTopic` operation (IAM action
 * `kafka:DescribeTopic`), scoped to one {@link ServerlessCluster}.
 *
 * Reads a topic's partition count, replication factor, configuration, and
 * status through the MSK control plane. Provide the implementation with
 * `Effect.provide(AWS.Kafka.DescribeTopicHttp)`.
 * ### Managing Topics
 * **Example:** Describe a Topic
 * ```typescript
 * const describeTopic = yield* Kafka.DescribeTopic(cluster);
 *
 * const topic = yield* describeTopic({ TopicName: "orders" });
 * // topic.PartitionCount, topic.Configs, topic.Status
 * ```
 *
 * @binding
 */
export interface DescribeTopic extends Binding.Service<
  DescribeTopic,
  "AWS.Kafka.DescribeTopic",
  (
    cluster: ServerlessCluster,
  ) => Effect.Effect<
    (
      request: Omit<kafka.DescribeTopicRequest, "ClusterArn">,
    ) => Effect.Effect<kafka.DescribeTopicResponse, kafka.DescribeTopicError>
  >
> {}
export const DescribeTopic = Binding.Service<DescribeTopic>("AWS.Kafka.DescribeTopic");

export const DescribeTopicHttp = Layer.effect(
  DescribeTopic,
  makeKafkaClusterHttpBinding({
    tag: "AWS.Kafka.DescribeTopic",
    operation: kafka.describeTopic,
    actions: [
      "kafka:DescribeTopic",
      "kafka-cluster:Connect",
      "kafka-cluster:DescribeTopic",
      "kafka-cluster:DescribeTopicDynamicConfiguration",
    ],
    topicScoped: true,
  }),
);
