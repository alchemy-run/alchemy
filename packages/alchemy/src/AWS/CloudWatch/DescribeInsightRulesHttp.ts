import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import {
  DescribeInsightRules,
  type DescribeInsightRulesRequest,
} from "./DescribeInsightRules.ts";

export const DescribeInsightRulesHttp = Layer.effect(
  DescribeInsightRules,
  Effect.gen(function* () {
    const describeInsightRules = yield* cloudwatch.describeInsightRules;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.CloudWatch.DescribeInsightRules())`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["cloudwatch:DescribeInsightRules"],
                  Resource: ["*"],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.CloudWatch.DescribeInsightRules`)(function* (
        request: DescribeInsightRulesRequest = {},
      ) {
        return yield* describeInsightRules(request);
      });
    });
  }),
);
