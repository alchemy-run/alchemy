import * as pubsublite from "@distilled.cloud/gcp/pubsublite_v1";
import * as Layer from "effect/Layer";
import { makeSubscriptionHttpBinding } from "./BindingHttp.ts";
import { CommitCursor } from "./CommitCursor.ts";

/**
 * HTTP implementation of {@link CommitCursor}.
 *
 * @layer
 * @provides GCP.Pubsublite.CommitCursor
 */
export const CommitCursorHttp = Layer.effect(
  CommitCursor,
  makeSubscriptionHttpBinding({
    tag: "GCP.Pubsublite.CommitCursor",
    field: "subscription",
    operation: pubsublite.commitCursorCursorProjectsLocationsSubscriptions,
  }),
);
