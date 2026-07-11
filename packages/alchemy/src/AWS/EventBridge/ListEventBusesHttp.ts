import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isBindingHost } from "../Lambda/Function.ts";
import {
  ListEventBuses,
  type ListEventBusesRequest,
} from "./ListEventBuses.ts";

/**
 * HTTP implementation of {@link ListEventBuses}. At deploy time it grants
 * `events:ListEventBuses`; at runtime it calls the EventBridge API with the
 * host Function's credentials. Provide this layer on the Function using the
 * binding.
 */
export const ListEventBusesHttp = Layer.effect(
  ListEventBuses,
  Effect.gen(function* () {
    const listEventBuses = yield* eventbridge.listEventBuses;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.EventBridge.ListEventBuses())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["events:ListEventBuses"],
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn(`AWS.EventBridge.ListEventBuses`)(function* (
        request?: ListEventBusesRequest,
      ) {
        return yield* listEventBuses(request ?? {});
      });
    });
  }),
);
