import * as sns from "@distilled.cloud/aws/sns";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeSnsAccountHttpBinding } from "./BindingHttp.ts";

export interface ListSMSSandboxPhoneNumbersRequest extends sns.ListSMSSandboxPhoneNumbersInput {}

/**
 * Runtime binding for `sns:ListSMSSandboxPhoneNumbers`.
 *
 * An account-scoped operation — lists the destination phone numbers
 * registered (verified or pending) in the account's SMS sandbox.
 * Provide the `ListSMSSandboxPhoneNumbersHttp` layer on the Function to implement the binding.
 * ### SMS Sandbox
 * **Example:** List Sandbox Numbers
 * ```typescript
 * const listSandboxNumbers = yield* SNS.ListSMSSandboxPhoneNumbers();
 * const { PhoneNumbers } = yield* listSandboxNumbers();
 * ```
 *
 * @binding
 */
export interface ListSMSSandboxPhoneNumbers extends Binding.Service<
  ListSMSSandboxPhoneNumbers,
  "AWS.SNS.ListSMSSandboxPhoneNumbers",
  () => Effect.Effect<
    (
      request?: ListSMSSandboxPhoneNumbersRequest,
    ) => Effect.Effect<sns.ListSMSSandboxPhoneNumbersResult, sns.ListSMSSandboxPhoneNumbersError>
  >
> {}

export const ListSMSSandboxPhoneNumbers = Binding.Service<ListSMSSandboxPhoneNumbers>(
  "AWS.SNS.ListSMSSandboxPhoneNumbers",
);

export const ListSMSSandboxPhoneNumbersHttp = Layer.effect(
  ListSMSSandboxPhoneNumbers,
  makeSnsAccountHttpBinding({
    tag: "AWS.SNS.ListSMSSandboxPhoneNumbers",
    operation: sns.listSMSSandboxPhoneNumbers,
    actions: ["sns:ListSMSSandboxPhoneNumbers", "sms-voice:DescribeVerifiedDestinationNumbers"],
  }),
);
