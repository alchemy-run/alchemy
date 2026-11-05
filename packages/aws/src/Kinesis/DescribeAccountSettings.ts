import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeKinesisAccountHttpBinding } from "./BindingHttp.ts";

export interface DescribeAccountSettingsRequest extends Kinesis.DescribeAccountSettingsInput {}

/**
 * Runtime binding for `kinesis:DescribeAccountSettings`.
 *
 * An account-level operation (no stream argument) that reports the account's
 * Kinesis settings, such as on-demand stream count quotas. Provide the
 * implementation with `Effect.provide(AWS.Kinesis.DescribeAccountSettingsHttp)`.
 * ### Account Settings
 * **Example:** Read the Account's Kinesis Settings
 * ```typescript
 * // init — account-level binding takes no resource
 * const describeAccountSettings = yield* AWS.Kinesis.DescribeAccountSettings();
 *
 * // runtime
 * const settings = yield* describeAccountSettings();
 * ```
 *
 * @binding
 */
export interface DescribeAccountSettings extends Binding.Service<
  DescribeAccountSettings,
  "AWS.Kinesis.DescribeAccountSettings",
  () => Effect.Effect<
    (
      request?: DescribeAccountSettingsRequest,
    ) => Effect.Effect<Kinesis.DescribeAccountSettingsOutput, Kinesis.DescribeAccountSettingsError>
  >
> {}

export const DescribeAccountSettings = Binding.Service<DescribeAccountSettings>(
  "AWS.Kinesis.DescribeAccountSettings",
);

export const DescribeAccountSettingsHttp = Layer.effect(
  DescribeAccountSettings,
  makeKinesisAccountHttpBinding({
    tag: "AWS.Kinesis.DescribeAccountSettings",
    operation: Kinesis.describeAccountSettings,
    actions: ["kinesis:DescribeAccountSettings"],
  }),
);
