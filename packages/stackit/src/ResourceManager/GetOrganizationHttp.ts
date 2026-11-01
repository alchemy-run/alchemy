import * as resourceManager from "@distilled.cloud/stackit/resource_manager";
import * as Layer from "effect/Layer";
import { makeOrganizationHttpBinding } from "./BindingHttp.ts";
import { GetOrganization } from "./GetOrganization.ts";

/**
 * HTTP implementation of {@link GetOrganization}.
 *
 * @layer
 * @provides Stackit.ResourceManager.GetOrganization
 */
export const GetOrganizationHttp = Layer.effect(
  GetOrganization,
  makeOrganizationHttpBinding({
    tag: "Stackit.ResourceManager.GetOrganization",
    access: { permissions: ["resource-manager.organization.get"] },
    fields: (id) => ({ id }),
    operation: resourceManager.getOrganization,
  }),
);
