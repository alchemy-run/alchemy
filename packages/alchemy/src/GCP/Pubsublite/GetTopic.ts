import type * as pubsublite from "@distilled.cloud/gcp/pubsublite_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { AdminTopic } from "./AdminTopic.ts";

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
 * ### Observing Topics
 * **Example:** Read the bound topic
 * ```typescript
 * const getTopic = yield* GCP.Pubsublite.GetTopic(events);
 * const live = yield* getTopic();
 * ```
 *
 * @binding
 * @product GCP
 * @category Pubsublite
 */
export interface GetTopic extends Binding.Service<
  GetTopic,
  "GCP.Pubsublite.GetTopic",
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

export const GetTopic = Binding.Service<GetTopic>("GCP.Pubsublite.GetTopic");
