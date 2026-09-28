import { makeScheduledEvents } from "../../Workers/Workerd/ScheduledEvents.ts";
import { DurableObjectState } from "./DurableObjectState.ts";

export type { ScheduledEvent } from "../../Workers/Workerd/ScheduledEvents.ts";
export const {
  scheduleEvent,
  cancelEvent,
  listEvents,
  processScheduledEvents,
} = makeScheduledEvents(DurableObjectState);
