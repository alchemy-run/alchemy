import * as licensemanager from "@distilled.cloud/aws/license-manager";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeLicenseManagerHttpBinding } from "./BindingHttp.ts";

/**
 * Request for {@link ListLicenseVersions}.
 */
export interface ListLicenseVersionsRequest extends licensemanager.ListLicenseVersionsRequest {}

/**
 * Runtime binding for `license-manager:ListLicenseVersions` — list all
 * versions of a seller-issued license.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.LicenseManager.ListLicenseVersionsHttp)`.
 * ### Reading Licenses and Grants
 * **Example:** List a License's Versions
 * ```typescript
 * // init
 * const listVersions = yield* AWS.LicenseManager.ListLicenseVersions();
 *
 * // runtime
 * const { Licenses } = yield* listVersions({ LicenseArn: licenseArn });
 * ```
 *
 * @binding
 */
export interface ListLicenseVersions extends Binding.Service<
  ListLicenseVersions,
  "AWS.LicenseManager.ListLicenseVersions",
  () => Effect.Effect<
    (
      request: ListLicenseVersionsRequest,
    ) => Effect.Effect<
      licensemanager.ListLicenseVersionsResponse,
      licensemanager.ListLicenseVersionsError
    >
  >
> {}
export const ListLicenseVersions = Binding.Service<ListLicenseVersions>(
  "AWS.LicenseManager.ListLicenseVersions",
);

export const ListLicenseVersionsHttp = Layer.effect(
  ListLicenseVersions,
  makeLicenseManagerHttpBinding({
    capability: "ListLicenseVersions",
    iamActions: ["license-manager:ListLicenseVersions"],
    operation: licensemanager.listLicenseVersions,
  }),
);
