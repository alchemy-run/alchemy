import * as scf from "@distilled.cloud/stackit/scf";
import * as Layer from "effect/Layer";
import { makeOrganizationProjectHttpBinding } from "./BindingHttp.ts";
import { ListOrganizations } from "./ListOrganizations.ts";

/**
 * HTTP implementation of {@link ListOrganizations}.
 *
 * @layer
 * @provides Stackit.CloudFoundry.ListOrganizations
 */
export const ListOrganizationsHttp = Layer.effect(
  ListOrganizations,
  makeOrganizationProjectHttpBinding({
    tag: "Stackit.CloudFoundry.ListOrganizations",
    permissions: ["scf.org.list"],
    operation: scf.listOrganizations,
  }),
);
