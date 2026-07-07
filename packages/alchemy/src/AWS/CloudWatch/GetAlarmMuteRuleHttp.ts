import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import type { AlarmMuteRule } from "./AlarmMuteRule.ts";
import {
  GetAlarmMuteRule,
  type GetAlarmMuteRuleRequest,
} from "./GetAlarmMuteRule.ts";

export const GetAlarmMuteRuleHttp = Layer.effect(
  GetAlarmMuteRule,
  Effect.gen(function* () {
    const getAlarmMuteRule = yield* cloudwatch.getAlarmMuteRule;

    return Effect.fn(function* (rule: AlarmMuteRule) {
      const AlarmMuteRuleName = yield* rule.alarmMuteRuleName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.CloudWatch.GetAlarmMuteRule(${rule}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["cloudwatch:GetAlarmMuteRule"],
                  Resource: [rule.alarmMuteRuleArn],
                },
              ],
            },
          );
        }
      }

      return Effect.fn(`AWS.CloudWatch.GetAlarmMuteRule(${rule.LogicalId})`)(
        function* (request: GetAlarmMuteRuleRequest = {}) {
          return yield* getAlarmMuteRule({
            ...request,
            AlarmMuteRuleName: yield* AlarmMuteRuleName,
          });
        },
      );
    });
  }),
);
