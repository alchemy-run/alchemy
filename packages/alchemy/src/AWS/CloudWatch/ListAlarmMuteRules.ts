import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface ListAlarmMuteRulesRequest
  extends cloudwatch.ListAlarmMuteRulesInput {}

/**
 * Runtime binding for `cloudwatch:ListAlarmMuteRules`.
 * @binding
 */
export interface ListAlarmMuteRules extends Binding.Service<
  ListAlarmMuteRules,
  "AWS.CloudWatch.ListAlarmMuteRules",
  () => Effect.Effect<
    (
      request?: ListAlarmMuteRulesRequest,
    ) => Effect.Effect<
      cloudwatch.ListAlarmMuteRulesOutput,
      cloudwatch.ListAlarmMuteRulesError
    >
  >
> {}

export const ListAlarmMuteRules = Binding.Service<ListAlarmMuteRules>(
  "AWS.CloudWatch.ListAlarmMuteRules",
);
