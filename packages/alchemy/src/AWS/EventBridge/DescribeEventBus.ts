import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { EventBus } from "./EventBus.ts";

export interface DescribeEventBusRequest extends Omit<
  eventbridge.DescribeEventBusRequest,
  "Name"
> {}

/** @binding */
export interface DescribeEventBus extends Binding.Service<
  DescribeEventBus,
  "AWS.EventBridge.DescribeEventBus",
  (
    bus: EventBus,
  ) => Effect.Effect<
    (
      request?: DescribeEventBusRequest,
    ) => Effect.Effect<
      eventbridge.DescribeEventBusResponse,
      eventbridge.DescribeEventBusError
    >
  >
> {}
export const DescribeEventBus = Binding.Service<DescribeEventBus>(
  "AWS.EventBridge.DescribeEventBus",
);
