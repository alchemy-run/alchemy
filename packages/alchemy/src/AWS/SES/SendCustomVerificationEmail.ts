import type * as sesv2 from "@distilled.cloud/aws/sesv2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `sesv2:SendCustomVerificationEmail`.
 *
 * Sends the branded verification email defined by a
 * {@link CustomVerificationEmailTemplate} to a new email address, kicking off
 * the address-verification flow. Pass the template name (from a bound
 * `CustomVerificationEmailTemplate` resource) and the address to verify.
 *
 * `ses:SendCustomVerificationEmail` is not resource-scopable to a template —
 * the template has no ARN — so this is an account-level binding invoked with
 * no resource argument. Provide the implementation with
 * `Effect.provide(AWS.SES.SendCustomVerificationEmailHttp)`.
 *
 * Note: actually sending a custom verification email requires the account to
 * be out of the SES sandbox — in the sandbox the call fails with the typed
 * `BadRequestException`.
 * @binding
 * @section Verifying Addresses
 * @example Send a Custom Verification Email
 * ```typescript
 * // init — account-level binding, no resource argument
 * const sendVerification = yield* SES.SendCustomVerificationEmail();
 *
 * // runtime
 * const { MessageId } = yield* sendVerification({
 *   EmailAddress: "new-user@example.com",
 *   TemplateName: yield* template.templateName,
 * });
 * ```
 */
export interface SendCustomVerificationEmail extends Binding.Service<
  SendCustomVerificationEmail,
  "AWS.SES.SendCustomVerificationEmail",
  () => Effect.Effect<
    (
      request: sesv2.SendCustomVerificationEmailRequest,
    ) => Effect.Effect<
      sesv2.SendCustomVerificationEmailResponse,
      sesv2.SendCustomVerificationEmailError
    >
  >
> {}
export const SendCustomVerificationEmail =
  Binding.Service<SendCustomVerificationEmail>(
    "AWS.SES.SendCustomVerificationEmail",
  );
