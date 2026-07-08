import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import {
  TestEventPattern,
  type TestEventPatternRequest,
} from "./TestEventPattern.ts";

export const TestEventPatternHttp = Layer.effect(
  TestEventPattern,
  Effect.gen(function* () {
    const testEventPattern = yield* eventbridge.testEventPattern;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
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
