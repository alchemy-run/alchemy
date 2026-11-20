import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeEventBridgeAccountHttpBinding } from "./BindingHttp.ts";

export interface ListEventBusesRequest extends eventbridge.ListEventBusesRequest {}

/**
 * Lists the event buses in the account (`events:ListEventBuses`).
 *
 * An account-level operation — bind it with no resource argument. Provide the
 * `ListEventBusesHttp` layer on the Function to satisfy the binding.
 * ### Listing Event Buses
 * **Example:** List All Event Buses
 * ```typescript
 * // init — no resource argument (provide AWS.EventBridge.ListEventBusesHttp on the Function)
 * const listEventBuses = yield* AWS.EventBridge.ListEventBuses();
 *
 * // runtime — list buses, optionally filtered by name prefix
 * const { EventBuses } = yield* listEventBuses({ NamePrefix: "my-app" });
 * ```
 *
 * @binding
 */
export interface ListEventBuses extends Binding.Service<
  ListEventBuses,
  "AWS.EventBridge.ListEventBuses",
  () => Effect.Effect<
    (
      request?: ListEventBusesRequest,
    ) => Effect.Effect<eventbridge.ListEventBusesResponse, eventbridge.ListEventBusesError>
  >
> {}
export const ListEventBuses = Binding.Service<ListEventBuses>("AWS.EventBridge.ListEventBuses");

/**
 * HTTP implementation of {@link ListEventBuses}. At deploy time it grants
 * `events:ListEventBuses`; at runtime it calls the EventBridge API with the
 * host Function's credentials. Provide this layer on the Function using the
 * binding.
 */
export const ListEventBusesHttp = Layer.effect(
  ListEventBuses,
  makeEventBridgeAccountHttpBinding({
    tag: "AWS.EventBridge.ListEventBuses",
    operation: eventbridge.listEventBuses,
    actions: ["events:ListEventBuses"],
  }),
);
