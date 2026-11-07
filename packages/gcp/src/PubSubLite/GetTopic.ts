import * as pubsublite from "@distilled.cloud/gcp/pubsublite_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { AdminTopic } from "./AdminTopic.ts";
import { makeTopicNameHttpBinding } from "./BindingHttp.ts";

export interface GetTopicRequest extends Omit<
  pubsublite.GetAdminProjectsLocationsTopicsRequest,
  "name"
> {}

/**
 * Runtime binding for Pub/Sub Lite `topics.get`.
 *
 * Bind this operation to an {@link AdminTopic} in a Function/Action init
 * phase. Provide {@link GetTopicHttp}.
 *
 * Grants `roles/pubsublite.viewer` on the project: Pub/Sub Lite has no
 * resource-level IAM.
 *
 * ### Observing Topics
 * **Example:** Read the bound topic
 * ```typescript
 * const getTopic = yield* GCP.PubSubLite.GetTopic(events);
 * const live = yield* getTopic();
 * ```
 *
 * @binding
 * @category PubSubLite
 */
export interface GetTopic extends Binding.Service<
  GetTopic,
  "GCP.PubSubLite.GetTopic",
  (
    topic: AdminTopic,
  ) => Effect.Effect<
    (
      request?: GetTopicRequest,
    ) => Effect.Effect<
      pubsublite.Topic,
      pubsublite.GetAdminProjectsLocationsTopicsError,
      RuntimeContext
    >
  >
> {}

export const GetTopic = Binding.Service<GetTopic>("GCP.PubSubLite.GetTopic");

/**
 * HTTP implementation of {@link GetTopic}.
 *
 * @layer
 * @provides GCP.PubSubLite.GetTopic
 */
export const GetTopicHttp = Layer.effect(
  GetTopic,
  makeTopicNameHttpBinding({
    tag: "GCP.PubSubLite.GetTopic",
    iam: { role: "roles/pubsublite.viewer" },
    operation: pubsublite.getAdminProjectsLocationsTopics,
  }),
);
