import * as frauddetector from "@distilled.cloud/aws/frauddetector";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Detector } from "./Detector.ts";
import {
  GetEventPrediction,
  type GetEventPredictionRequest,
} from "./GetEventPrediction.ts";

export const GetEventPredictionHttp = Layer.effect(
  GetEventPrediction,
  Effect.gen(function* () {
    const getEventPrediction = yield* frauddetector.getEventPrediction;

    return Effect.fn(function* (detector: Detector) {
      // Output yields a DEFERRED effect — resolve again per invocation below.
      const DetectorId = yield* detector.detectorId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.FraudDetector.GetEventPrediction(${detector}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["frauddetector:GetEventPrediction"],
                  Resource: [detector.arn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(
        `AWS.FraudDetector.GetEventPrediction(${detector.LogicalId})`,
      )(function* (request: GetEventPredictionRequest) {
        const detectorId = yield* DetectorId;
        return yield* getEventPrediction({ ...request, detectorId });
      });
    });
  }),
);
