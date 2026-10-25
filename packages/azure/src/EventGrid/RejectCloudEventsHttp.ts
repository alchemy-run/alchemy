import * as ns from "@distilled.cloud/azure/eventgrid-namespace";
import * as Layer from "effect/Layer";
import { EventGridRole, makeSubscriptionHttpBinding } from "./BindingHttp.ts";
import { RejectCloudEvents } from "./RejectCloudEvents.ts";

/**
 * Implementation of {@link RejectCloudEvents} over the distilled
 * `eventgrid-namespace` data
 * plane. Assigns the custom `AzureEventGridReceiveRole` on the event
 * subscription.
 *
 * @layer
 * @provides Azure.EventGrid.RejectCloudEvents
 */
export const RejectCloudEventsHttp = Layer.effect(
  RejectCloudEvents,
  makeSubscriptionHttpBinding({
    tag: "Azure.EventGrid.RejectCloudEvents",
    operation: ns.RejectCloudEvents,
    grants: [EventGridRole.Receive],
  }),
);
