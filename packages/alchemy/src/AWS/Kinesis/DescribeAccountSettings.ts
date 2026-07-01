import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface DescribeAccountSettingsRequest
  extends Kinesis.DescribeAccountSettingsInput {}

/** @binding */
export interface DescribeAccountSettings extends Binding.Service<
  DescribeAccountSettings,
  "AWS.Kinesis.DescribeAccountSettings",
  () => Effect.Effect<
    (
      request?: DescribeAccountSettingsRequest,
    ) => Effect.Effect<
      Kinesis.DescribeAccountSettingsOutput,
      Kinesis.DescribeAccountSettingsError
    >
  >
> {}

export const DescribeAccountSettings = Binding.Service<DescribeAccountSettings>(
  "AWS.Kinesis.DescribeAccountSettings",
);
