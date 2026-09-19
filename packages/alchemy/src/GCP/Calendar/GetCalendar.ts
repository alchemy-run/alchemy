import type * as calendar from "@distilled.cloud/gcp/calendar_v3";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Calendar } from "./Calendar.ts";

export interface GetCalendarRequest extends Omit<
  calendar.GetCalendarsRequest,
  "calendarId"
> {}

/**
 * Runtime binding for Calendar `calendars.get`.
 *
 * Bind this operation to a {@link Calendar} in a Function/Action init
 * phase. Provide {@link GetCalendarHttp}.
 *
 * ### Reading Calendars
 * **Example:** Read calendar metadata
 * ```typescript
 * const getCalendar = yield* GCP.Calendar.GetCalendar(cal);
 * const metadata = yield* getCalendar({});
 * ```
 *
 * @binding
 * @product GCP
 * @category Calendar
 */
export interface GetCalendar extends Binding.Service<
  GetCalendar,
  "GCP.Calendar.GetCalendar",
  (
    cal: Calendar,
  ) => Effect.Effect<
    (
      request: GetCalendarRequest,
    ) => Effect.Effect<
      calendar.Calendar,
      calendar.GetCalendarsError,
      RuntimeContext
    >
  >
> {}

export const GetCalendar = Binding.Service<GetCalendar>(
  "GCP.Calendar.GetCalendar",
);
