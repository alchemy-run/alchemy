import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { AlarmResource } from "./binding-common.ts";

type AlarmResources = [AlarmResource, ...AlarmResource[]];

/**
 * Runtime binding for `cloudwatch:DisableAlarmActions`.
 * @binding
 */
export interface DisableAlarmActions extends Binding.Service<
  DisableAlarmActions,
  "AWS.CloudWatch.DisableAlarmActions",
  (
    ...alarms: AlarmResources
  ) => Effect.Effect<
    () => Effect.Effect<cloudwatch.DisableAlarmActionsResponse, any>
  >
> {}

export const DisableAlarmActions = Binding.Service<DisableAlarmActions>(
  "AWS.CloudWatch.DisableAlarmActions",
);
