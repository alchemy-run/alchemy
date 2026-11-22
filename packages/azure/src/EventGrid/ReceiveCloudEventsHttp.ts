import * as ns from "@distilled.cloud/azure/eventgrid-namespace";
import * as Layer from "effect/Layer";
import { EventGridRole, makeSubscriptionHttpBinding } from "./BindingHttp.ts";
import { ReceiveCloudEvents } from "./ReceiveCloudEvents.ts";

/**
 * Implementation of {@link ReceiveCloudEvents} over the distilled
 * `eventgrid-namespace` data
 * plane. Assigns the custom `AzureEventGridReceiveRole` on the event
 * subscription.
 *
 * @layer
 * @provides Azure.EventGrid.ReceiveCloudEvents
 */
export const ReceiveCloudEventsHttp = Layer.effect(
  ReceiveCloudEvents,
  makeSubscriptionHttpBinding({
    tag: "Azure.EventGrid.ReceiveCloudEvents",
    operation: ns.ReceiveCloudEvents,
    grants: [EventGridRole.Receive],
  }),
);
