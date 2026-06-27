import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import {
  GetMetricStream,
  type GetMetricStreamRequest,
} from "./GetMetricStream.ts";
import type { MetricStream } from "./MetricStream.ts";

export const GetMetricStreamHttp = Layer.effect(
  GetMetricStream,
  Effect.gen(function* () {
    const getMetricStream = yield* cloudwatch.getMetricStream;

    return Effect.fn(function* (metricStream: MetricStream) {
      const Name = yield* metricStream.metricStreamName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.CloudWatch.GetMetricStream(${metricStream}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["cloudwatch:GetMetricStream"],
                  Resource: [metricStream.metricStreamArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(
        `AWS.CloudWatch.GetMetricStream(${metricStream.LogicalId})`,
      )(function* (request: GetMetricStreamRequest = {}) {
        return yield* getMetricStream({
          ...request,
          Name: yield* Name,
        });
      });
    });
  }),
);
