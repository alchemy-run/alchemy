import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeEventBridgeBusHttpBinding } from "./BindingHttp.ts";
import type { EventBus } from "./EventBus.ts";

export interface DescribeEventBusRequest extends Omit<
  eventbridge.DescribeEventBusRequest,
  "Name"
> {}

/**
 * Reads the configuration of an EventBridge event bus
 * (`events:DescribeEventBus`).
 *
 * Bind this operation to an {@link EventBus} inside a function runtime to get
 * a callable that automatically injects the bus name. Provide the
 * `DescribeEventBusHttp` layer on the Function to satisfy the binding.
 * ### Describing Event Buses
 * **Example:** Describe the Bound Bus
 * ```typescript
 * // init — bind the bus (provide AWS.EventBridge.DescribeEventBusHttp on the Function)
 * const describeEventBus = yield* AWS.EventBridge.DescribeEventBus(bus);
 *
 * // runtime — read the bus configuration
 * const info = yield* describeEventBus();
 * console.log(info.Arn, info.Policy);
 * ```
 *
 * @binding
 */
export interface DescribeEventBus extends Binding.Service<
  DescribeEventBus,
  "AWS.EventBridge.DescribeEventBus",
  (
    bus: EventBus,
  ) => Effect.Effect<
    (
      request?: DescribeEventBusRequest,
    ) => Effect.Effect<eventbridge.DescribeEventBusResponse, eventbridge.DescribeEventBusError>
  >
> {}
export const DescribeEventBus = Binding.Service<DescribeEventBus>(
  "AWS.EventBridge.DescribeEventBus",
);

/**
 * HTTP implementation of {@link DescribeEventBus}. At deploy time it grants
 * `events:DescribeEventBus` on the bound bus; at runtime it calls the
 * EventBridge API with the host Function's credentials. Provide this layer on
 * the Function using the binding.
 */
export const DescribeEventBusHttp = Layer.effect(
  DescribeEventBus,
  makeEventBridgeBusHttpBinding({
    tag: "AWS.EventBridge.DescribeEventBus",
    operation: eventbridge.describeEventBus,
    actions: ["events:DescribeEventBus"],
    busNameKey: "Name",
  }),
);
