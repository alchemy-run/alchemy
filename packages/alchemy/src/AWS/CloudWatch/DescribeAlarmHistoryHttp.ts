import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import {
  DescribeAlarmHistory,
  type DescribeAlarmHistoryRequest,
} from "./DescribeAlarmHistory.ts";

export const DescribeAlarmHistoryHttp = Layer.effect(
  DescribeAlarmHistory,
  Effect.gen(function* () {
    const describeAlarmHistory = yield* cloudwatch.describeAlarmHistory;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.CloudWatch.DescribeAlarmHistory())`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["cloudwatch:DescribeAlarmHistory"],
                  Resource: ["*"],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.CloudWatch.DescribeAlarmHistory`)(function* (
        request: DescribeAlarmHistoryRequest = {},
      ) {
        return yield* describeAlarmHistory(request);
      });
    });
  }),
);
