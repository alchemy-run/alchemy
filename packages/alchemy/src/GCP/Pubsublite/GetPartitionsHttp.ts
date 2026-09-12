import * as pubsublite from "@distilled.cloud/gcp/pubsublite_v1";
import * as Layer from "effect/Layer";
import { makeTopicNameHttpBinding } from "./BindingHttp.ts";
import { GetPartitions } from "./GetPartitions.ts";

/**
 * HTTP implementation of {@link GetPartitions}.
 *
 * @layer
 * @provides GCP.Pubsublite.GetPartitions
 */
export const GetPartitionsHttp = Layer.effect(
  GetPartitions,
  makeTopicNameHttpBinding({
    tag: "GCP.Pubsublite.GetPartitions",
    operation: pubsublite.getPartitionsAdminProjectsLocationsTopics,
  }),
);
