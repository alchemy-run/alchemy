import * as telemetry from "@distilled.cloud/stackit/telemetry_link";
import * as Layer from "effect/Layer";
import { GetProjectLink } from "./GetProjectLink.ts";
import { makeProjectLinkHttpBinding } from "./LinkBindingHttp.ts";

/**
 * HTTP implementation of {@link GetProjectLink}.
 *
 * @layer
 * @provides Stackit.Telemetry.GetProjectLink
 */
export const GetProjectLinkHttp = Layer.effect(
  GetProjectLink,
  makeProjectLinkHttpBinding({
    tag: "Stackit.Telemetry.GetProjectLink",
    permission: "telemetry-link.instance.get",
    operation: telemetry.getProjectTelemetryLink,
  }),
);
