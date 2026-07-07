import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import type { AlarmResource } from "./binding-common.ts";
import {
  DescribeAlarmContributors,
  type DescribeAlarmContributorsRequest,
} from "./DescribeAlarmContributors.ts";

export const DescribeAlarmContributorsHttp = Layer.effect(
  DescribeAlarmContributors,
  Effect.gen(function* () {
    const describeAlarmContributors =
      yield* cloudwatch.describeAlarmContributors;

    return Effect.fn(function* (alarm: AlarmResource) {
      const AlarmName = yield* alarm.alarmName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.CloudWatch.DescribeAlarmContributors(${alarm}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["cloudwatch:DescribeAlarmContributors"],
                  Resource: [alarm.alarmArn],
                },
              ],
            },
          );
        }
      }

      return Effect.fn(
        `AWS.CloudWatch.DescribeAlarmContributors(${alarm.LogicalId})`,
      )(function* (request: DescribeAlarmContributorsRequest = {}) {
        return yield* describeAlarmContributors({
          ...request,
          AlarmName: yield* AlarmName,
        });
      });
    });
  }),
);
