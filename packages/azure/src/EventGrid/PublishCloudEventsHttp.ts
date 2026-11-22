import * as ns from "@distilled.cloud/azure/eventgrid-namespace";
import * as Layer from "effect/Layer";
import { EventGridRole, makeNamespaceTopicHttpBinding } from "./BindingHttp.ts";
import { PublishCloudEvents } from "./PublishCloudEvents.ts";

/**
 * Implementation of {@link PublishCloudEvents} over the distilled
 * `eventgrid-namespace` data
 * plane. Assigns the built-in **EventGrid Data Sender** role on the namespace
 * topic.
 *
 * @layer
 * @provides Azure.EventGrid.PublishCloudEvents
 */
export const PublishCloudEventsHttp = Layer.effect(
  PublishCloudEvents,
  makeNamespaceTopicHttpBinding({
    tag: "Azure.EventGrid.PublishCloudEvents",
    operation: ns.PublishCloudEvents,
    grants: [EventGridRole.Send],
  }),
);
