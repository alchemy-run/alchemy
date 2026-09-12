import type * as calendar from "@distilled.cloud/gcp/calendar_v3";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Event } from "./Event.ts";

export interface GetEventRequest extends Omit<
  calendar.GetEventsRequest,
  "calendarId" | "eventId"
> {}

/**
 * Runtime binding for Calendar `events.get`.
 *
 * Bind this operation to an {@link Event} in a Function/Action init
 * phase. Provide {@link GetEventHttp}.
 *
 * ### Reading Events
 * **Example:** Read event metadata
 * ```typescript
 * const getEvent = yield* GCP.Calendar.GetEvent(event);
 * const metadata = yield* getEvent({});
 * ```
 *
 * @binding
 * @product GCP
 * @category Calendar
 */
export interface GetEvent extends Binding.Service<
  GetEvent,
  "GCP.Calendar.GetEvent",
  (
    event: Event,
  ) => Effect.Effect<
    (
      request: GetEventRequest,
    ) => Effect.Effect<calendar.Event, calendar.GetEventsError, RuntimeContext>
  >
> {}

export const GetEvent = Binding.Service<GetEvent>("GCP.Calendar.GetEvent");
