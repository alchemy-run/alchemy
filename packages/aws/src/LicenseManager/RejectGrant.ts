import * as licensemanager from "@distilled.cloud/aws/license-manager";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeLicenseManagerHttpBinding } from "./BindingHttp.ts";

/**
 * Request for {@link RejectGrant}.
 */
export interface RejectGrantRequest extends licensemanager.RejectGrantRequest {}

/**
 * Runtime binding for `license-manager:RejectGrant` — reject a license
 * grant that another account distributed to this account.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.LicenseManager.RejectGrantHttp)`.
 * ### Managing Grants
 * **Example:** Reject a Received Grant
 * ```typescript
 * // init
 * const rejectGrant = yield* AWS.LicenseManager.RejectGrant();
 *
 * // runtime
 * const { Status } = yield* rejectGrant({ GrantArn: grantArn });
 * ```
 *
 * @binding
 */
export interface RejectGrant extends Binding.Service<
  RejectGrant,
  "AWS.LicenseManager.RejectGrant",
  () => Effect.Effect<
    (
      request: RejectGrantRequest,
    ) => Effect.Effect<licensemanager.RejectGrantResponse, licensemanager.RejectGrantError>
  >
> {}
export const RejectGrant = Binding.Service<RejectGrant>("AWS.LicenseManager.RejectGrant");

export const RejectGrantHttp = Layer.effect(
  RejectGrant,
  makeLicenseManagerHttpBinding({
    capability: "RejectGrant",
    iamActions: ["license-manager:RejectGrant"],
    operation: licensemanager.rejectGrant,
  }),
);
