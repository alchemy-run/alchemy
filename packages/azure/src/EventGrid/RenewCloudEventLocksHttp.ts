import * as ns from "@distilled.cloud/azure/eventgrid-namespace";
import * as Layer from "effect/Layer";
import { EventGridRole, makeSubscriptionHttpBinding } from "./BindingHttp.ts";
import { RenewCloudEventLocks } from "./RenewCloudEventLocks.ts";

/**
 * Implementation of {@link RenewCloudEventLocks} over the distilled
 * `eventgrid-namespace` data
 * plane. Assigns the custom `AzureEventGridReceiveRole` on the event
 * subscription.
 *
 * @layer
 * @provides Azure.EventGrid.RenewCloudEventLocks
 */
export const RenewCloudEventLocksHttp = Layer.effect(
  RenewCloudEventLocks,
  makeSubscriptionHttpBinding({
    tag: "Azure.EventGrid.RenewCloudEventLocks",
    operation: ns.RenewCloudEventLocks,
    grants: [EventGridRole.Receive],
  }),
);
