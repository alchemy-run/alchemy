import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import {
  DescribeAlarmsForMetric,
  type DescribeAlarmsForMetricRequest,
} from "./DescribeAlarmsForMetric.ts";

export const DescribeAlarmsForMetricHttp = Layer.effect(
  DescribeAlarmsForMetric,
  Effect.gen(function* () {
    const describeAlarmsForMetric = yield* cloudwatch.describeAlarmsForMetric;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.CloudWatch.DescribeAlarmsForMetric())`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["cloudwatch:DescribeAlarmsForMetric"],
                  Resource: ["*"],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.CloudWatch.DescribeAlarmsForMetric`)(function* (
        request: DescribeAlarmsForMetricRequest,
      ) {
        return yield* describeAlarmsForMetric(request);
      });
    });
  }),
);
