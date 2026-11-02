import * as telemetry from "@distilled.cloud/stackit/telemetry_link";
import * as Layer from "effect/Layer";
import { GetOrganizationBackflushJob } from "./GetOrganizationBackflushJob.ts";
import { makeOrganizationLinkHttpBinding } from "./LinkBindingHttp.ts";

/**
 * HTTP implementation of {@link GetOrganizationBackflushJob}.
 *
 * @layer
 * @provides Stackit.Telemetry.GetOrganizationBackflushJob
 */
export const GetOrganizationBackflushJobHttp = Layer.effect(
  GetOrganizationBackflushJob,
  makeOrganizationLinkHttpBinding({
    tag: "Stackit.Telemetry.GetOrganizationBackflushJob",
    permission: "telemetry-link.instance.get",
    operation: telemetry.getOrganizationBackflushJob,
  }),
);
