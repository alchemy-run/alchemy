import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { EventBus } from "./EventBus.ts";

export interface PutEventsRequest extends Omit<
  eventbridge.PutEventsRequest,
  "Entries"
> {
  Entries: Array<Omit<eventbridge.PutEventsRequestEntry, "EventBusName">>;
}

/** @binding */
export interface PutEvents extends Binding.Service<
  PutEvents,
  "AWS.EventBridge.PutEvents",
  (
    bus?: EventBus,
  ) => Effect.Effect<
    (
      request: PutEventsRequest,
    ) => Effect.Effect<
      eventbridge.PutEventsResponse,
      eventbridge.PutEventsError
    >
  >
> {}
export const PutEvents = Binding.Service<PutEvents>(
  "AWS.EventBridge.PutEvents",
);
