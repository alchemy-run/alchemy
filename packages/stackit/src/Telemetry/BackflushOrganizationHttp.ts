import * as telemetry from "@distilled.cloud/stackit/telemetry_link";
import * as Layer from "effect/Layer";
import { BackflushOrganization } from "./BackflushOrganization.ts";
import { makeOrganizationLinkHttpBinding } from "./LinkBindingHttp.ts";

/**
 * HTTP implementation of {@link BackflushOrganization}.
 *
 * @layer
 * @provides Stackit.Telemetry.BackflushOrganization
 */
export const BackflushOrganizationHttp = Layer.effect(
  BackflushOrganization,
  makeOrganizationLinkHttpBinding({
    tag: "Stackit.Telemetry.BackflushOrganization",
    permission: "telemetry-link.instance.update",
    operation: telemetry.createOrganizationBackflushJob,
  }),
);
