import * as ns from "@distilled.cloud/azure/eventgrid-namespace";
import * as Layer from "effect/Layer";
import { AcknowledgeCloudEvents } from "./AcknowledgeCloudEvents.ts";
import { EventGridRole, makeSubscriptionHttpBinding } from "./BindingHttp.ts";

/**
 * Implementation of {@link AcknowledgeCloudEvents} over the distilled
 * `eventgrid-namespace` data
 * plane. Assigns the custom `AzureEventGridReceiveRole` on the event
 * subscription.
 *
 * @layer
 * @provides Azure.EventGrid.AcknowledgeCloudEvents
 */
export const AcknowledgeCloudEventsHttp = Layer.effect(
  AcknowledgeCloudEvents,
  makeSubscriptionHttpBinding({
    tag: "Azure.EventGrid.AcknowledgeCloudEvents",
    operation: ns.AcknowledgeCloudEvents,
    grants: [EventGridRole.Receive],
  }),
);
