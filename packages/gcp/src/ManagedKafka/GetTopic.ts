import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as kafka from "@distilled.cloud/gcp/managedkafka_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import { makeManagedKafkaHttpBinding } from "./BindingHttp.ts";
import type { ClustersTopic } from "./ClustersTopic.ts";

export interface GetTopicRequest extends Omit<
  kafka.GetProjectsLocationsClustersTopicsRequest,
  "name"
> {}

/**
 * Runtime binding for Managed Kafka `topics.get`.
 *
 * Bind this operation to a {@link ClustersTopic} in a Function/Action
 * init phase. Provide {@link GetTopicHttp}.
 *
 * ### Observing Topics
 * **Example:** Read the bound topic
 * ```typescript
 * const getTopic = yield* GCP.ManagedKafka.GetTopic(topic);
 * const live = yield* getTopic();
 * ```
 *
 * @binding
 * @category ManagedKafka
 */
export interface GetTopic extends Binding.Service<
  GetTopic,
  "GCP.ManagedKafka.GetTopic",
  (
    topic: ClustersTopic,
  ) => Effect.Effect<
    (
      request?: GetTopicRequest,
    ) => Effect.Effect<kafka.Topic, kafka.GetProjectsLocationsClustersTopicsError, RuntimeContext>
  >
> {}

export const GetTopic = Binding.Service<GetTopic>("GCP.ManagedKafka.GetTopic");

/**
 * HTTP implementation of {@link GetTopic}.
 *
 * @layer
 * @provides GCP.ManagedKafka.GetTopic
 */
export const GetTopicHttp: Layer.Layer<GetTopic, never, Credentials | HttpClient.HttpClient> =
  Layer.effect(
    GetTopic,
    makeManagedKafkaHttpBinding<ClustersTopic>()<
      kafka.GetProjectsLocationsClustersTopicsRequest,
      kafka.Topic,
      kafka.GetProjectsLocationsClustersTopicsError
    >({
      tag: "GCP.ManagedKafka.GetTopic",
      iam: { role: "roles/managedkafka.viewer", scopeByCondition: true },
      operation: kafka.getProjectsLocationsClustersTopics,
    }),
  );
