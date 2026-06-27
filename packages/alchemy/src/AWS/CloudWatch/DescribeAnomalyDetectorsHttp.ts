import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import {
  DescribeAnomalyDetectors,
  type DescribeAnomalyDetectorsRequest,
} from "./DescribeAnomalyDetectors.ts";

export const DescribeAnomalyDetectorsHttp = Layer.effect(
  DescribeAnomalyDetectors,
  Effect.gen(function* () {
    const describeAnomalyDetectors = yield* cloudwatch.describeAnomalyDetectors;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.CloudWatch.DescribeAnomalyDetectors())`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["cloudwatch:DescribeAnomalyDetectors"],
                  Resource: ["*"],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.CloudWatch.DescribeAnomalyDetectors`)(function* (
        request: DescribeAnomalyDetectorsRequest = {},
      ) {
        return yield* describeAnomalyDetectors(request);
      });
    });
  }),
);
