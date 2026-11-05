import * as sns from "@distilled.cloud/aws/sns";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeSnsAccountHttpBinding } from "./BindingHttp.ts";

export interface VerifySMSSandboxPhoneNumberRequest extends sns.VerifySMSSandboxPhoneNumberInput {}

/**
 * Runtime binding for `sns:VerifySMSSandboxPhoneNumber`.
 *
 * An account-scoped operation — verifies a sandbox destination phone
 * number with the one-time password SNS texted to it.
 * Provide the `VerifySMSSandboxPhoneNumberHttp` layer on the Function to implement the binding.
 * ### SMS Sandbox
 * **Example:** Verify a Sandbox Number
 * ```typescript
 * const verifySandboxNumber = yield* SNS.VerifySMSSandboxPhoneNumber();
 * yield* verifySandboxNumber({
 *   PhoneNumber: "+15555550123",
 *   OneTimePassword: "123456",
 * });
 * ```
 *
 * @binding
 */
export interface VerifySMSSandboxPhoneNumber extends Binding.Service<
  VerifySMSSandboxPhoneNumber,
  "AWS.SNS.VerifySMSSandboxPhoneNumber",
  () => Effect.Effect<
    (
      request: VerifySMSSandboxPhoneNumberRequest,
    ) => Effect.Effect<sns.VerifySMSSandboxPhoneNumberResult, sns.VerifySMSSandboxPhoneNumberError>
  >
> {}

export const VerifySMSSandboxPhoneNumber = Binding.Service<VerifySMSSandboxPhoneNumber>(
  "AWS.SNS.VerifySMSSandboxPhoneNumber",
);

export const VerifySMSSandboxPhoneNumberHttp = Layer.effect(
  VerifySMSSandboxPhoneNumber,
  makeSnsAccountHttpBinding({
    tag: "AWS.SNS.VerifySMSSandboxPhoneNumber",
    operation: sns.verifySMSSandboxPhoneNumber,
    actions: ["sns:VerifySMSSandboxPhoneNumber", "sms-voice:VerifyDestinationNumber"],
  }),
);
