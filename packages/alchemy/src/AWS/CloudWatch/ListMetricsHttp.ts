import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import { ListMetrics, type ListMetricsRequest } from "./ListMetrics.ts";

export const ListMetricsHttp = Layer.effect(
  ListMetrics,
  Effect.gen(function* () {
    const listMetrics = yield* cloudwatch.listMetrics;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.CloudWatch.ListMetrics())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["cloudwatch:ListMetrics"],
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn(`AWS.CloudWatch.ListMetrics`)(function* (
        request: ListMetricsRequest = {},
      ) {
        return yield* listMetrics(request);
      });
    });
  }),
);
