import * as sns from "@distilled.cloud/aws/sns";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeSnsAccountHttpBinding } from "./BindingHttp.ts";

export interface CreateSMSSandboxPhoneNumberRequest extends sns.CreateSMSSandboxPhoneNumberInput {}

/**
 * Runtime binding for `sns:CreateSMSSandboxPhoneNumber`.
 *
 * An account-scoped operation — registers a destination phone number in
 * the SMS sandbox, which sends it a one-time verification code.
 * Provide the `CreateSMSSandboxPhoneNumberHttp` layer on the Function to implement the binding.
 * ### SMS Sandbox
 * **Example:** Register a Sandbox Number
 * ```typescript
 * const createSandboxNumber = yield* SNS.CreateSMSSandboxPhoneNumber();
 * yield* createSandboxNumber({ PhoneNumber: "+15555550123" });
 * ```
 *
 * @binding
 */
export interface CreateSMSSandboxPhoneNumber extends Binding.Service<
  CreateSMSSandboxPhoneNumber,
  "AWS.SNS.CreateSMSSandboxPhoneNumber",
  () => Effect.Effect<
    (
      request: CreateSMSSandboxPhoneNumberRequest,
    ) => Effect.Effect<sns.CreateSMSSandboxPhoneNumberResult, sns.CreateSMSSandboxPhoneNumberError>
  >
> {}

export const CreateSMSSandboxPhoneNumber = Binding.Service<CreateSMSSandboxPhoneNumber>(
  "AWS.SNS.CreateSMSSandboxPhoneNumber",
);

export const CreateSMSSandboxPhoneNumberHttp = Layer.effect(
  CreateSMSSandboxPhoneNumber,
  makeSnsAccountHttpBinding({
    tag: "AWS.SNS.CreateSMSSandboxPhoneNumber",
    operation: sns.createSMSSandboxPhoneNumber,
    // Registering a sandbox number creates a verified destination number
    // and sends the OTP text via End User Messaging (probe-verified).
    actions: [
      "sns:CreateSMSSandboxPhoneNumber",
      "sms-voice:CreateVerifiedDestinationNumber",
      "sms-voice:SendDestinationNumberVerificationCode",
      "sms-voice:SendTextMessage",
    ],
  }),
);
