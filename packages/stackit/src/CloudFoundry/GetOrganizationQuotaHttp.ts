import * as scf from "@distilled.cloud/stackit/scf";
import * as Layer from "effect/Layer";
import { makeOrganizationHttpBinding } from "./BindingHttp.ts";
import { GetOrganizationQuota } from "./GetOrganizationQuota.ts";

/**
 * HTTP implementation of {@link GetOrganizationQuota}.
 *
 * @layer
 * @provides Stackit.CloudFoundry.GetOrganizationQuota
 */
export const GetOrganizationQuotaHttp = Layer.effect(
  GetOrganizationQuota,
  makeOrganizationHttpBinding({
    tag: "Stackit.CloudFoundry.GetOrganizationQuota",
    permissions: ["scf.org.quota.get"],
    operation: scf.getOrganizationQuota,
  }),
);
