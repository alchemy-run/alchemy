import * as scf from "@distilled.cloud/stackit/scf";
import * as Layer from "effect/Layer";
import { makeOrganizationHttpBinding } from "./BindingHttp.ts";
import { GetOrganizationUsageSummary } from "./GetOrganizationUsageSummary.ts";

/**
 * HTTP implementation of {@link GetOrganizationUsageSummary}.
 *
 * @layer
 * @provides Stackit.CloudFoundry.GetOrganizationUsageSummary
 */
export const GetOrganizationUsageSummaryHttp = Layer.effect(
  GetOrganizationUsageSummary,
  makeOrganizationHttpBinding({
    tag: "Stackit.CloudFoundry.GetOrganizationUsageSummary",
    permissions: ["scf.org.usage.get"],
    operation: scf.getOrganizationUsageSummary,
  }),
);
