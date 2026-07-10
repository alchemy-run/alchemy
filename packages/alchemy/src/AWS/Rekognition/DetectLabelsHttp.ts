import * as rekognition from "@distilled.cloud/aws/rekognition";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { DetectLabels } from "./DetectLabels.ts";

export const DetectLabelsHttp = Layer.effect(
  DetectLabels,
  Effect.gen(function* () {
    const detectLabels = yield* rekognition.detectLabels;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.Rekognition.DetectLabels())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["rekognition:DetectLabels"],
                // rekognition:DetectLabels has no resource-level IAM
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn("AWS.Rekognition.DetectLabels")(function* (
        request: rekognition.DetectLabelsRequest,
      ) {
        return yield* detectLabels(request);
      });
    });
  }),
);
