import * as ns from "@distilled.cloud/azure/eventgrid-namespace";
import * as Layer from "effect/Layer";
import { EventGridRole, makeNamespaceTopicHttpBinding } from "./BindingHttp.ts";
import { PublishCloudEvent } from "./PublishCloudEvent.ts";

/**
 * Implementation of {@link PublishCloudEvent} over the distilled
 * `eventgrid-namespace` data
 * plane. Assigns the built-in **EventGrid Data Sender** role on the namespace
 * topic.
 *
 * @layer
 * @provides Azure.EventGrid.PublishCloudEvent
 */
export const PublishCloudEventHttp = Layer.effect(
  PublishCloudEvent,
  makeNamespaceTopicHttpBinding({
    tag: "Azure.EventGrid.PublishCloudEvent",
    operation: ns.PublishCloudEvent,
    grants: [EventGridRole.Send],
  }),
);
