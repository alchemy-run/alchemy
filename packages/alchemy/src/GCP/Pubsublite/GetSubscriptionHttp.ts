import * as pubsublite from "@distilled.cloud/gcp/pubsublite_v1";
import * as Layer from "effect/Layer";
import { makeSubscriptionHttpBinding } from "./BindingHttp.ts";
import { GetSubscription } from "./GetSubscription.ts";

/**
 * HTTP implementation of {@link GetSubscription}.
 *
 * @layer
 * @provides GCP.Pubsublite.GetSubscription
 */
export const GetSubscriptionHttp = Layer.effect(
  GetSubscription,
  makeSubscriptionHttpBinding({
    tag: "GCP.Pubsublite.GetSubscription",
    field: "name",
    operation: pubsublite.getAdminProjectsLocationsSubscriptions,
  }),
);
