import * as telemetry from "@distilled.cloud/stackit/telemetry_link";
import * as Layer from "effect/Layer";
import { makeOrganizationLinkHttpBinding } from "./LinkBindingHttp.ts";
import { ListOrganizationBackflushJobs } from "./ListOrganizationBackflushJobs.ts";

/**
 * HTTP implementation of {@link ListOrganizationBackflushJobs}.
 *
 * @layer
 * @provides Stackit.Telemetry.ListOrganizationBackflushJobs
 */
export const ListOrganizationBackflushJobsHttp = Layer.effect(
  ListOrganizationBackflushJobs,
  makeOrganizationLinkHttpBinding({
    tag: "Stackit.Telemetry.ListOrganizationBackflushJobs",
    permission: "telemetry-link.instance.get",
    operation: telemetry.listOrganizationBackflushJobs,
  }),
);
