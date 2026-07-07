import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { AlarmResource } from "./binding-common.ts";

export interface DescribeAlarmsRequest extends Omit<
  cloudwatch.DescribeAlarmsInput,
  "AlarmNames"
> {}

type AlarmResources = [AlarmResource, ...AlarmResource[]];

/**
 * Runtime binding for `cloudwatch:DescribeAlarms`.
 * @binding
 */
export interface DescribeAlarms extends Binding.Service<
  DescribeAlarms,
  "AWS.CloudWatch.DescribeAlarms",
  (
    ...alarms: AlarmResources
  ) => Effect.Effect<
    (
      request?: DescribeAlarmsRequest,
    ) => Effect.Effect<cloudwatch.DescribeAlarmsOutput, any>
  >
> {}

export const DescribeAlarms = Binding.Service<DescribeAlarms>(
  "AWS.CloudWatch.DescribeAlarms",
);
