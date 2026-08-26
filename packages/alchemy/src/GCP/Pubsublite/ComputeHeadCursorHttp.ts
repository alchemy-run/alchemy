import * as pubsublite from "@distilled.cloud/gcp/pubsublite_v1";
import * as Layer from "effect/Layer";
import { makeTopicStatsHttpBinding } from "./BindingHttp.ts";
import { ComputeHeadCursor } from "./ComputeHeadCursor.ts";

/**
 * HTTP implementation of {@link ComputeHeadCursor}.
 *
 * @layer
 * @provides GCP.Pubsublite.ComputeHeadCursor
 */
export const ComputeHeadCursorHttp = Layer.effect(
  ComputeHeadCursor,
  makeTopicStatsHttpBinding({
    tag: "GCP.Pubsublite.ComputeHeadCursor",
    operation: pubsublite.computeHeadCursorTopicStatsProjectsLocationsTopics,
  }),
);
