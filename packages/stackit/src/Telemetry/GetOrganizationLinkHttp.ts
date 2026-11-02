import * as telemetry from "@distilled.cloud/stackit/telemetry_link";
import * as Layer from "effect/Layer";
import { GetOrganizationLink } from "./GetOrganizationLink.ts";
import { makeOrganizationLinkHttpBinding } from "./LinkBindingHttp.ts";

/**
 * HTTP implementation of {@link GetOrganizationLink}.
 *
 * @layer
 * @provides Stackit.Telemetry.GetOrganizationLink
 */
export const GetOrganizationLinkHttp = Layer.effect(
  GetOrganizationLink,
  makeOrganizationLinkHttpBinding({
    tag: "Stackit.Telemetry.GetOrganizationLink",
    permission: "telemetry-link.instance.get",
    operation: telemetry.getOrganizationTelemetryLink,
  }),
);
