import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isBindingHost } from "../Lambda/Function.ts";
import {
  TestEventPattern,
  type TestEventPatternRequest,
} from "./TestEventPattern.ts";

/**
 * HTTP implementation of {@link TestEventPattern}. At deploy time it grants
 * `events:TestEventPattern`; at runtime it calls the EventBridge API with the
 * host Function's credentials. Provide this layer on the Function using the
 * binding.
 */
export const TestEventPatternHttp = Layer.effect(
  TestEventPattern,
  Effect.gen(function* () {
    const testEventPattern = yield* eventbridge.testEventPattern;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.EventBridge.TestEventPattern())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["events:TestEventPattern"],
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn(`AWS.EventBridge.TestEventPattern`)(function* (
        request: TestEventPatternRequest,
      ) {
        return yield* testEventPattern(request);
      });
    });
  }),
);
