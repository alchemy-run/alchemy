import * as telemetry from "@distilled.cloud/stackit/telemetry_link";
import * as Layer from "effect/Layer";
import { BackflushProject } from "./BackflushProject.ts";
import { makeProjectLinkHttpBinding } from "./LinkBindingHttp.ts";

/**
 * HTTP implementation of {@link BackflushProject}.
 *
 * @layer
 * @provides Stackit.Telemetry.BackflushProject
 */
export const BackflushProjectHttp = Layer.effect(
  BackflushProject,
  makeProjectLinkHttpBinding({
    tag: "Stackit.Telemetry.BackflushProject",
    permission: "telemetry-link.instance.update",
    operation: telemetry.createProjectBackflushJob,
  }),
);
