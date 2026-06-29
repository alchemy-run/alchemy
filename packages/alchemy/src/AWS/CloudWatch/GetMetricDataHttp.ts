import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import { GetMetricData, type GetMetricDataRequest } from "./GetMetricData.ts";

export const GetMetricDataHttp = Layer.effect(
  GetMetricData,
  Effect.gen(function* () {
    const getMetricData = yield* cloudwatch.getMetricData;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.CloudWatch.GetMetricData())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["cloudwatch:GetMetricData"],
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn(`AWS.CloudWatch.GetMetricData`)(function* (
        request: GetMetricDataRequest,
      ) {
        return yield* getMetricData(request);
      });
    });
  }),
);
