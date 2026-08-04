import type * as sesv2 from "@distilled.cloud/aws/sesv2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ConfigurationSet } from "./ConfigurationSet.ts";
import type { EmailIdentity } from "./EmailIdentity.ts";

/**
 * Runtime binding for `sesv2:SendCustomVerificationEmail`.
 *
 * Sends the branded verification email defined by a
 * {@link CustomVerificationEmailTemplate} to a new email address, kicking off
 * the address-verification flow. Pass the template name and the address to
 * verify; SES takes the FROM address from the template.
 *
 * Bind it to the {@link EmailIdentity} the verification email is sent from —
 * the identity is not injected into the request (the template carries the
 * FROM address), it scopes the IAM grant. Without it the binding would hand
 * the function a send-capable action on every identity in the account.
 * Optionally bind a {@link ConfigurationSet}, which is injected into each
 * request.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.SES.SendCustomVerificationEmailHttp)`.
 *
 * Note: actually sending a custom verification email requires the account to
 * be out of the SES sandbox — in the sandbox the call fails with the typed
 * `BadRequestException`.
 * @binding
 * @section Verifying Addresses
 * @example Send a Custom Verification Email
 * ```typescript
 * // init — scoped to the identity the template sends from
 * const sendVerification = yield* SES.SendCustomVerificationEmail(identity);
 *
 * // runtime
 * const { MessageId } = yield* sendVerification({
 *   EmailAddress: "new-user@example.com",
 *   TemplateName: yield* template.templateName,
 * });
 * ```
 *
 * @example Attribute the Send to a Configuration Set
 * ```typescript
 * // ConfigurationSetName is injected into every request
 * const sendVerification = yield* SES.SendCustomVerificationEmail(
 *   identity,
 *   configSet,
 * );
 * ```
 */
export interface SendCustomVerificationEmail extends Binding.Service<
  SendCustomVerificationEmail,
  "AWS.SES.SendCustomVerificationEmail",
  <Identity extends EmailIdentity>(
    identity: Identity,
    configurationSet?: ConfigurationSet,
  ) => Effect.Effect<
    (
      request: Omit<
        sesv2.SendCustomVerificationEmailRequest,
        "ConfigurationSetName"
      >,
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
