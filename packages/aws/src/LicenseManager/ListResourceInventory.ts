import * as licensemanager from "@distilled.cloud/aws/license-manager";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeLicenseManagerHttpBinding } from "./BindingHttp.ts";

/**
 * Request for {@link ListResourceInventory}.
 */
export interface ListResourceInventoryRequest extends licensemanager.ListResourceInventoryRequest {}

/**
 * Runtime binding for `license-manager:ListResourceInventory` — list the
 * resource inventory (instances and their platform details) discovered by
 * License Manager via Systems Manager inventory.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.LicenseManager.ListResourceInventoryHttp)`.
 * ### Resource Inventory and Specifications
 * **Example:** List Discovered Resources
 * ```typescript
 * // init
 * const listInventory = yield* AWS.LicenseManager.ListResourceInventory();
 *
 * // runtime
 * const { ResourceInventoryList } = yield* listInventory();
 * ```
 *
 * @binding
 */
export interface ListResourceInventory extends Binding.Service<
  ListResourceInventory,
  "AWS.LicenseManager.ListResourceInventory",
  () => Effect.Effect<
    (
      request?: ListResourceInventoryRequest,
    ) => Effect.Effect<
      licensemanager.ListResourceInventoryResponse,
      licensemanager.ListResourceInventoryError
    >
  >
> {}
export const ListResourceInventory = Binding.Service<ListResourceInventory>(
  "AWS.LicenseManager.ListResourceInventory",
);

export const ListResourceInventoryHttp = Layer.effect(
  ListResourceInventory,
  makeLicenseManagerHttpBinding({
    capability: "ListResourceInventory",
    iamActions: ["license-manager:ListResourceInventory"],
    operation: licensemanager.listResourceInventory,
  }),
);
