import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import {
  DescribeEventBus,
  type DescribeEventBusRequest,
} from "./DescribeEventBus.ts";
import type { EventBus } from "./EventBus.ts";

export const DescribeEventBusHttp = Layer.effect(
  DescribeEventBus,
  Effect.gen(function* () {
    const describeEventBus = yield* eventbridge.describeEventBus;

    return Effect.fn(function* (bus: EventBus) {
      const Name = yield* bus.eventBusName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.EventBridge.DescribeEventBus(${bus}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["events:DescribeEventBus"],
                  Resource: [bus.eventBusArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.EventBridge.DescribeEventBus(${bus.LogicalId})`)(
        function* (request?: DescribeEventBusRequest) {
          return yield* describeEventBus({
            ...request,
            Name: yield* Name,
          });
        },
      );
    });
  }),
);
