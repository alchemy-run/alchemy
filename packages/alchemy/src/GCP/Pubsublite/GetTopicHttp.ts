import * as pubsublite from "@distilled.cloud/gcp/pubsublite_v1";
import * as Layer from "effect/Layer";
import { makeTopicNameHttpBinding } from "./BindingHttp.ts";
import { GetTopic } from "./GetTopic.ts";

/**
 * HTTP implementation of {@link GetTopic}.
 *
 * @layer
 * @provides GCP.Pubsublite.GetTopic
 */
export const GetTopicHttp = Layer.effect(
  GetTopic,
  makeTopicNameHttpBinding({
    tag: "GCP.Pubsublite.GetTopic",
    operation: pubsublite.getAdminProjectsLocationsTopics,
  }),
);
