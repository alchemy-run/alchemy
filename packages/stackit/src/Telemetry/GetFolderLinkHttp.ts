import * as telemetry from "@distilled.cloud/stackit/telemetry_link";
import * as Layer from "effect/Layer";
import { GetFolderLink } from "./GetFolderLink.ts";
import { makeFolderLinkHttpBinding } from "./LinkBindingHttp.ts";

/**
 * HTTP implementation of {@link GetFolderLink}.
 *
 * @layer
 * @provides Stackit.Telemetry.GetFolderLink
 */
export const GetFolderLinkHttp = Layer.effect(
  GetFolderLink,
  makeFolderLinkHttpBinding({
    tag: "Stackit.Telemetry.GetFolderLink",
    permission: "telemetry-link.instance.get",
    operation: telemetry.getFolderTelemetryLink,
  }),
);
