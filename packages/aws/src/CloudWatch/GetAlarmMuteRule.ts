import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { AlarmMuteRule } from "./AlarmMuteRule.ts";
import { makeCloudWatchResourceHttpBinding } from "./BindingHttp.ts";

export interface GetAlarmMuteRuleRequest extends Omit<
  cloudwatch.GetAlarmMuteRuleInput,
  "AlarmMuteRuleName"
> {}

/**
 * Runtime binding for `cloudwatch:GetAlarmMuteRule` — read the
 * configuration of the bound {@link AlarmMuteRule}; the rule name is
 * injected automatically.
 *
 * Provide `CloudWatch.GetAlarmMuteRuleHttp` on the hosting Lambda Function
 * to satisfy the requirement.
 * ### Reading Mute Rules
 * **Example:** Read a Bound Mute Rule
 * ```typescript
 * // init — grants cloudwatch:GetAlarmMuteRule on the rule
 * const getAlarmMuteRule = yield* AWS.CloudWatch.GetAlarmMuteRule(muteRule);
 *
 * // runtime
 * const result = yield* getAlarmMuteRule();
 * const schedule = result.Rule?.Schedule;
 * ```
 *
 * @binding
 */
export interface GetAlarmMuteRule extends Binding.Service<
  GetAlarmMuteRule,
  "AWS.CloudWatch.GetAlarmMuteRule",
  (
    rule: AlarmMuteRule,
  ) => Effect.Effect<
    (
      request?: GetAlarmMuteRuleRequest,
    ) => Effect.Effect<cloudwatch.GetAlarmMuteRuleOutput, cloudwatch.GetAlarmMuteRuleError>
  >
> {}

export const GetAlarmMuteRule = Binding.Service<GetAlarmMuteRule>(
  "AWS.CloudWatch.GetAlarmMuteRule",
);

export const GetAlarmMuteRuleHttp = Layer.effect(
  GetAlarmMuteRule,
  makeCloudWatchResourceHttpBinding({
    tag: "AWS.CloudWatch.GetAlarmMuteRule",
    operation: cloudwatch.getAlarmMuteRule,
    actions: ["cloudwatch:GetAlarmMuteRule"],
    requestKey: "AlarmMuteRuleName",
    identifier: (rule: AlarmMuteRule) => rule.alarmMuteRuleName,
    resourceArn: (rule: AlarmMuteRule) => rule.alarmMuteRuleArn,
  }),
);
