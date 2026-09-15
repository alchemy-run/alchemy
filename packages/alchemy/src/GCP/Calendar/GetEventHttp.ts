import * as calendar from "@distilled.cloud/gcp/calendar_v3";
import * as Layer from "effect/Layer";
import { makeEventHttpBinding } from "./BindingHttp.ts";
import { GetEvent } from "./GetEvent.ts";

/**
 * HTTP implementation of {@link GetEvent}.
 *
 * @layer
 * @provides GCP.Calendar.GetEvent
 */
export const GetEventHttp = Layer.effect(
  GetEvent,
  makeEventHttpBinding({
    tag: "GCP.Calendar.GetEvent",
    operation: calendar.getEvents,
  }),
);
