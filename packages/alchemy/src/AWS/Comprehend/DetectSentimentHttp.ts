import * as comprehend from "@distilled.cloud/aws/comprehend";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import { DetectSentiment } from "./DetectSentiment.ts";

export const DetectSentimentHttp = Layer.effect(
  DetectSentiment,
  Effect.gen(function* () {
    const detectSentiment = yield* comprehend.detectSentiment;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.Comprehend.DetectSentiment())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["comprehend:DetectSentiment"],
                // comprehend:DetectSentiment has no resource-level IAM
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn("AWS.Comprehend.DetectSentiment")(function* (
        request: comprehend.DetectSentimentRequest,
      ) {
        return yield* detectSentiment(request);
      });
    });
  }),
);
