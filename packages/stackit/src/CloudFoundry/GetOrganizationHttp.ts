import * as scf from "@distilled.cloud/stackit/scf";
import * as Layer from "effect/Layer";
import { makeOrganizationHttpBinding } from "./BindingHttp.ts";
import { GetOrganization } from "./GetOrganization.ts";

/**
 * HTTP implementation of {@link GetOrganization}.
 *
 * @layer
 * @provides Stackit.CloudFoundry.GetOrganization
 */
export const GetOrganizationHttp = Layer.effect(
  GetOrganization,
  makeOrganizationHttpBinding({
    tag: "Stackit.CloudFoundry.GetOrganization",
    permissions: ["scf.org.get"],
    operation: scf.getOrganization,
  }),
);
