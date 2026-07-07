import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface ListEventBusesRequest
  extends eventbridge.ListEventBusesRequest {}

/** @binding */
export interface ListEventBuses extends Binding.Service<
  ListEventBuses,
  "AWS.EventBridge.ListEventBuses",
  () => Effect.Effect<
    (
      request?: ListEventBusesRequest,
    ) => Effect.Effect<
      eventbridge.ListEventBusesResponse,
      eventbridge.ListEventBusesError
    >
  >
> {}
export const ListEventBuses = Binding.Service<ListEventBuses>(
  "AWS.EventBridge.ListEventBuses",
);
