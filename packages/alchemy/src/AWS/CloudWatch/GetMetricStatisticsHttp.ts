import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import {
  GetMetricStatistics,
  type GetMetricStatisticsRequest,
} from "./GetMetricStatistics.ts";

export const GetMetricStatisticsHttp = Layer.effect(
  GetMetricStatistics,
  Effect.gen(function* () {
    const getMetricStatistics = yield* cloudwatch.getMetricStatistics;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.CloudWatch.GetMetricStatistics())`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["cloudwatch:GetMetricStatistics"],
                  Resource: ["*"],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.CloudWatch.GetMetricStatistics`)(function* (
        request: GetMetricStatisticsRequest,
      ) {
        return yield* getMetricStatistics(request);
      });
    });
  }),
);
