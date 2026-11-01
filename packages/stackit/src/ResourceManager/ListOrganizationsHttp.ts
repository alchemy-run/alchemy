import * as resourceManager from "@distilled.cloud/stackit/resource_manager";
import * as Layer from "effect/Layer";
import { makeOrganizationHttpBinding } from "./BindingHttp.ts";
import { ListOrganizations } from "./ListOrganizations.ts";

/**
 * HTTP implementation of {@link ListOrganizations}.
 *
 * @layer
 * @provides Stackit.ResourceManager.ListOrganizations
 */
export const ListOrganizationsHttp = Layer.effect(
  ListOrganizations,
  makeOrganizationHttpBinding({
    tag: "Stackit.ResourceManager.ListOrganizations",
    access: {
      permissions: ["resource-manager.organization.list", "resource-manager.organization.get"],
    },
    fields: () => ({}),
    operation: resourceManager.listOrganizations,
  }),
);
