import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { AlarmMuteRule } from "./AlarmMuteRule.ts";

export interface GetAlarmMuteRuleRequest extends Omit<
  cloudwatch.GetAlarmMuteRuleInput,
  "AlarmMuteRuleName"
> {}

/**
 * Runtime binding for `cloudwatch:GetAlarmMuteRule`.
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
    ) => Effect.Effect<
      cloudwatch.GetAlarmMuteRuleOutput,
      cloudwatch.GetAlarmMuteRuleError
    >
  >
> {}

export const GetAlarmMuteRule = Binding.Service<GetAlarmMuteRule>(
  "AWS.CloudWatch.GetAlarmMuteRule",
);
