import * as ns from "@distilled.cloud/azure/eventgrid-namespace";
import * as Layer from "effect/Layer";
import { EventGridRole, makeSubscriptionHttpBinding } from "./BindingHttp.ts";
import { ReleaseCloudEvents } from "./ReleaseCloudEvents.ts";

/**
 * Implementation of {@link ReleaseCloudEvents} over the distilled
 * `eventgrid-namespace` data
 * plane. Assigns the custom `AzureEventGridReceiveRole` on the event
 * subscription.
 *
 * @layer
 * @provides Azure.EventGrid.ReleaseCloudEvents
 */
export const ReleaseCloudEventsHttp = Layer.effect(
  ReleaseCloudEvents,
  makeSubscriptionHttpBinding({
    tag: "Azure.EventGrid.ReleaseCloudEvents",
    operation: ns.ReleaseCloudEvents,
    grants: [EventGridRole.Receive],
  }),
);
