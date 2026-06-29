import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import {
  GetMetricWidgetImage,
  type GetMetricWidgetImageRequest,
} from "./GetMetricWidgetImage.ts";

export const GetMetricWidgetImageHttp = Layer.effect(
  GetMetricWidgetImage,
  Effect.gen(function* () {
    const getMetricWidgetImage = yield* cloudwatch.getMetricWidgetImage;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.CloudWatch.GetMetricWidgetImage())`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["cloudwatch:GetMetricWidgetImage"],
                  Resource: ["*"],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.CloudWatch.GetMetricWidgetImage`)(function* (
        request: GetMetricWidgetImageRequest,
      ) {
        return yield* getMetricWidgetImage(request);
      });
    });
  }),
);
