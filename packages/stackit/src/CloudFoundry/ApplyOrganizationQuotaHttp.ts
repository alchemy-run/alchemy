import * as scf from "@distilled.cloud/stackit/scf";
import * as Layer from "effect/Layer";
import { ApplyOrganizationQuota } from "./ApplyOrganizationQuota.ts";
import { makeOrganizationHttpBinding } from "./BindingHttp.ts";

/**
 * HTTP implementation of {@link ApplyOrganizationQuota}.
 *
 * @layer
 * @provides Stackit.CloudFoundry.ApplyOrganizationQuota
 */
export const ApplyOrganizationQuotaHttp = Layer.effect(
  ApplyOrganizationQuota,
  makeOrganizationHttpBinding({
    tag: "Stackit.CloudFoundry.ApplyOrganizationQuota",
    permissions: ["scf.org.quota.update"],
    operation: scf.applyOrganizationQuota,
  }),
);
