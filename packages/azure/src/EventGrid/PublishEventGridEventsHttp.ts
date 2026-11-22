import * as dp from "@distilled.cloud/azure/eventgrid-data";
import * as Layer from "effect/Layer";
import { EventGridRole, makeTopicHttpBinding } from "./BindingHttp.ts";
import { PublishEventGridEvents } from "./PublishEventGridEvents.ts";

/**
 * Implementation of {@link PublishEventGridEvents} over the distilled
 * `eventgrid-data` data
 * plane. Assigns the built-in **EventGrid Data Sender** role on the topic.
 *
 * @layer
 * @provides Azure.EventGrid.PublishEventGridEvents
 */
export const PublishEventGridEventsHttp = Layer.effect(
  PublishEventGridEvents,
  makeTopicHttpBinding({
    tag: "Azure.EventGrid.PublishEventGridEvents",
    operation: dp.PublishEventGridEvents,
    grants: [EventGridRole.Send],
  }),
);
