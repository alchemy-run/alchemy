import * as dp from "@distilled.cloud/azure/eventgrid-data";
import * as Layer from "effect/Layer";
import { EventGridRole, makeTopicHttpBinding } from "./BindingHttp.ts";
import { PublishCustomEventEvents } from "./PublishCustomEventEvents.ts";

/**
 * Implementation of {@link PublishCustomEventEvents} over the distilled
 * `eventgrid-data` data
 * plane. Assigns the built-in **EventGrid Data Sender** role on the topic.
 *
 * @layer
 * @provides Azure.EventGrid.PublishCustomEventEvents
 */
export const PublishCustomEventEventsHttp = Layer.effect(
  PublishCustomEventEvents,
  makeTopicHttpBinding({
    tag: "Azure.EventGrid.PublishCustomEventEvents",
    operation: dp.PublishCustomEventEvents,
    grants: [EventGridRole.Send],
  }),
);
