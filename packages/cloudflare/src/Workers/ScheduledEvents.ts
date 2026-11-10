import { makeScheduledEvents } from "alchemy/Workers/Workerd/ScheduledEvents";
import { DurableObjectState } from "./DurableObjectState.ts";

export type { ScheduledEvent } from "alchemy/Workers/Workerd/ScheduledEvents";

/**
 * Durable Object scheduled events: `scheduleEvent` persists a named event in
 * SQLite and sets the alarm to the earliest pending `runAt`, `cancelEvent`
 * removes one, `listEvents` lists them, and `processScheduledEvents` (called
 * from the object's `alarm` handler) fires every due event.
 */
export const { scheduleEvent, cancelEvent, listEvents, processScheduledEvents } =
  makeScheduledEvents(DurableObjectState);
