import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import { PutMetricData, type PutMetricDataRequest } from "./PutMetricData.ts";

export const PutMetricDataHttp = Layer.effect(
  PutMetricData,
  Effect.gen(function* () {
    const putMetricData = yield* cloudwatch.putMetricData;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.CloudWatch.PutMetricData())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["cloudwatch:PutMetricData"],
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn(`AWS.CloudWatch.PutMetricData`)(function* (
        request: PutMetricDataRequest,
      ) {
        return yield* putMetricData(request);
      });
    });
  }),
);
