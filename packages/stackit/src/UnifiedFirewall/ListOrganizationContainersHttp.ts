import * as ufw from "@distilled.cloud/stackit/ufw";
import * as Layer from "effect/Layer";
import { makeOrganizationHttpBinding } from "../ResourceManager/BindingHttp.ts";
import { ListOrganizationContainers } from "./ListOrganizationContainers.ts";

/**
 * HTTP implementation of {@link ListOrganizationContainers}.
 *
 * @layer
 * @provides Stackit.UnifiedFirewall.ListOrganizationContainers
 */
export const ListOrganizationContainersHttp = Layer.effect(
  ListOrganizationContainers,
  makeOrganizationHttpBinding({
    tag: "Stackit.UnifiedFirewall.ListOrganizationContainers",
    access: { permissions: ["ufw.organization.list"] },
    fields: (organizationId) => ({ organizationId }),
    operation: ufw.listOrganizationContainers,
  }),
);
