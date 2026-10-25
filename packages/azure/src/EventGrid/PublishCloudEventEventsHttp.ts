import * as dp from "@distilled.cloud/azure/eventgrid-data";
import * as Layer from "effect/Layer";
import { EventGridRole, makeTopicHttpBinding } from "./BindingHttp.ts";
import { PublishCloudEventEvents } from "./PublishCloudEventEvents.ts";

/**
 * Implementation of {@link PublishCloudEventEvents} over the distilled
 * `eventgrid-data` data
 * plane. Assigns the built-in **EventGrid Data Sender** role on the topic.
 *
 * @layer
 * @provides Azure.EventGrid.PublishCloudEventEvents
 */
export const PublishCloudEventEventsHttp = Layer.effect(
  PublishCloudEventEvents,
  makeTopicHttpBinding({
    tag: "Azure.EventGrid.PublishCloudEventEvents",
    operation: dp.PublishCloudEventEvents,
    grants: [EventGridRole.Send],
  }),
);
