import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import {
  ListMetricStreams,
  type ListMetricStreamsRequest,
} from "./ListMetricStreams.ts";

export const ListMetricStreamsHttp = Layer.effect(
  ListMetricStreams,
  Effect.gen(function* () {
    const listMetricStreams = yield* cloudwatch.listMetricStreams;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.CloudWatch.ListMetricStreams())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["cloudwatch:ListMetricStreams"],
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn(`AWS.CloudWatch.ListMetricStreams`)(function* (
        request: ListMetricStreamsRequest = {},
      ) {
        return yield* listMetricStreams(request);
      });
    });
  }),
);
