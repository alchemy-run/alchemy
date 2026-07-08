import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { AlarmResource } from "./binding-common.ts";

export interface SetAlarmStateRequest extends Omit<
  cloudwatch.SetAlarmStateInput,
  "AlarmName"
> {}

/**
 * Runtime binding for `cloudwatch:SetAlarmState`.
 * @binding
 */
export interface SetAlarmState extends Binding.Service<
  SetAlarmState,
  "AWS.CloudWatch.SetAlarmState",
  (
    alarm: AlarmResource,
  ) => Effect.Effect<
    (
      request: SetAlarmStateRequest,
    ) => Effect.Effect<
      cloudwatch.SetAlarmStateResponse,
      cloudwatch.SetAlarmStateError
    >
  >
> {}

export const SetAlarmState = Binding.Service<SetAlarmState>(
  "AWS.CloudWatch.SetAlarmState",
);
