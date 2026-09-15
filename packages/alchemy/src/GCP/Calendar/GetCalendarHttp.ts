import * as calendar from "@distilled.cloud/gcp/calendar_v3";
import * as Layer from "effect/Layer";
import { makeCalendarHttpBinding } from "./BindingHttp.ts";
import { GetCalendar } from "./GetCalendar.ts";

/**
 * HTTP implementation of {@link GetCalendar}.
 *
 * @layer
 * @provides GCP.Calendar.GetCalendar
 */
export const GetCalendarHttp = Layer.effect(
  GetCalendar,
  makeCalendarHttpBinding({
    tag: "GCP.Calendar.GetCalendar",
    operation: calendar.getCalendars,
  }),
);
