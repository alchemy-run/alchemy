import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import {
  ListEventBuses,
  type ListEventBusesRequest,
} from "./ListEventBuses.ts";

export const ListEventBusesHttp = Layer.effect(
  ListEventBuses,
  Effect.gen(function* () {
    const listEventBuses = yield* eventbridge.listEventBuses;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
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
