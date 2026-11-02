import * as scf from "@distilled.cloud/stackit/scf";
import * as Layer from "effect/Layer";
import { makeOrganizationHttpBinding } from "./BindingHttp.ts";
import { ListOrganizationQuotas } from "./ListOrganizationQuotas.ts";

/**
 * HTTP implementation of {@link ListOrganizationQuotas}.
 *
 * @layer
 * @provides Stackit.CloudFoundry.ListOrganizationQuotas
 */
export const ListOrganizationQuotasHttp = Layer.effect(
  ListOrganizationQuotas,
  makeOrganizationHttpBinding({
    tag: "Stackit.CloudFoundry.ListOrganizationQuotas",
    permissions: ["scf.org.quota.list"],
    operation: scf.listOrganizationQuotas,
  }),
);
