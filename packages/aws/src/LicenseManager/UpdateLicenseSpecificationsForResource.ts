import * as licensemanager from "@distilled.cloud/aws/license-manager";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeLicenseManagerHttpBinding } from "./BindingHttp.ts";

/**
 * Request for {@link UpdateLicenseSpecificationsForResource}.
 */
export interface UpdateLicenseSpecificationsForResourceRequest
  extends licensemanager.UpdateLicenseSpecificationsForResourceRequest {}

/**
 * Runtime binding for
 * `license-manager:UpdateLicenseSpecificationsForResource` — associate or
 * disassociate license configurations with a resource (e.g. attach a
 * license configuration to an AMI so launches are tracked).
 *
 * Provide the implementation with
 * `Effect.provide(AWS.LicenseManager.UpdateLicenseSpecificationsForResourceHttp)`.
 * ### Resource Inventory and Specifications
 * **Example:** Attach a License Configuration to an AMI
 * ```typescript
 * // init
 * const updateSpecifications =
 *   yield* AWS.LicenseManager.UpdateLicenseSpecificationsForResource();
 *
 * // runtime
 * yield* updateSpecifications({
 *   ResourceArn: amiArn,
 *   AddLicenseSpecifications: [
 *     { LicenseConfigurationArn: configurationArn },
 *   ],
 * });
 * ```
 *
 * @binding
 */
export interface UpdateLicenseSpecificationsForResource extends Binding.Service<
  UpdateLicenseSpecificationsForResource,
  "AWS.LicenseManager.UpdateLicenseSpecificationsForResource",
  () => Effect.Effect<
    (
      request: UpdateLicenseSpecificationsForResourceRequest,
    ) => Effect.Effect<
      licensemanager.UpdateLicenseSpecificationsForResourceResponse,
      licensemanager.UpdateLicenseSpecificationsForResourceError
    >
  >
> {}
export const UpdateLicenseSpecificationsForResource =
  Binding.Service<UpdateLicenseSpecificationsForResource>(
    "AWS.LicenseManager.UpdateLicenseSpecificationsForResource",
  );

export const UpdateLicenseSpecificationsForResourceHttp = Layer.effect(
  UpdateLicenseSpecificationsForResource,
  makeLicenseManagerHttpBinding({
    capability: "UpdateLicenseSpecificationsForResource",
    iamActions: ["license-manager:UpdateLicenseSpecificationsForResource"],
    operation: licensemanager.updateLicenseSpecificationsForResource,
  }),
);
