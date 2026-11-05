import * as sns from "@distilled.cloud/aws/sns";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeSnsAccountHttpBinding } from "./BindingHttp.ts";

export interface GetSMSAttributesRequest extends sns.GetSMSAttributesInput {}

/**
 * Runtime binding for `sns:GetSMSAttributes`.
 *
 * An account-scoped operation — reads the account-level SMS settings such
 * as `DefaultSMSType`, `MonthlySpendLimit`, and delivery-status sampling.
 * Provide the `GetSMSAttributesHttp` layer on the Function to implement the binding.
 * ### SMS Account Settings
 * **Example:** Read SMS Settings
 * ```typescript
 * const getSmsAttributes = yield* SNS.GetSMSAttributes();
 * const { attributes } = yield* getSmsAttributes();
 * ```
 *
 * @binding
 */
export interface GetSMSAttributes extends Binding.Service<
  GetSMSAttributes,
  "AWS.SNS.GetSMSAttributes",
  () => Effect.Effect<
    (
      request?: GetSMSAttributesRequest,
    ) => Effect.Effect<sns.GetSMSAttributesResponse, sns.GetSMSAttributesError>
  >
> {}

export const GetSMSAttributes = Binding.Service<GetSMSAttributes>("AWS.SNS.GetSMSAttributes");

export const GetSMSAttributesHttp = Layer.effect(
  GetSMSAttributes,
  makeSnsAccountHttpBinding({
    tag: "AWS.SNS.GetSMSAttributes",
    operation: sns.getSMSAttributes,
    // SNS SMS preferences are backed by AWS End User Messaging — the read
    // fans out to `sms-voice:DescribeSpendLimits` (probe-verified).
    actions: ["sns:GetSMSAttributes", "sms-voice:DescribeSpendLimits"],
  }),
);
