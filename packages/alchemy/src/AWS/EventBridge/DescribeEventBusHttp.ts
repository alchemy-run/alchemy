import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isBindingHost } from "../Lambda/Function.ts";
import {
  DescribeEventBus,
  type DescribeEventBusRequest,
} from "./DescribeEventBus.ts";
import type { EventBus } from "./EventBus.ts";

/**
 * HTTP implementation of {@link DescribeEventBus}. At deploy time it grants
 * `events:DescribeEventBus` on the bound bus; at runtime it calls the
 * EventBridge API with the host Function's credentials. Provide this layer on
 * the Function using the binding.
 */
export const DescribeEventBusHttp = Layer.effect(
  DescribeEventBus,
  Effect.gen(function* () {
    const describeEventBus = yield* eventbridge.describeEventBus;

    return Effect.fn(function* (bus: EventBus) {
      const Name = yield* bus.eventBusName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
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
