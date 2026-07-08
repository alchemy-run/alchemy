import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { AlarmResource } from "./binding-common.ts";

export interface DescribeAlarmContributorsRequest extends Omit<
  cloudwatch.DescribeAlarmContributorsInput,
  "AlarmName"
> {}

/**
 * Runtime binding for `cloudwatch:DescribeAlarmContributors`.
 * @binding
 */
export interface DescribeAlarmContributors extends Binding.Service<
  DescribeAlarmContributors,
  "AWS.CloudWatch.DescribeAlarmContributors",
  (
    alarm: AlarmResource,
  ) => Effect.Effect<
    (
      request?: DescribeAlarmContributorsRequest,
    ) => Effect.Effect<
      cloudwatch.DescribeAlarmContributorsOutput,
      cloudwatch.DescribeAlarmContributorsError
    >
  >
> {}

export const DescribeAlarmContributors =
  Binding.Service<DescribeAlarmContributors>(
    "AWS.CloudWatch.DescribeAlarmContributors",
  );
