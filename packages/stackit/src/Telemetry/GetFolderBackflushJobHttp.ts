import * as telemetry from "@distilled.cloud/stackit/telemetry_link";
import * as Layer from "effect/Layer";
import { GetFolderBackflushJob } from "./GetFolderBackflushJob.ts";
import { makeFolderLinkHttpBinding } from "./LinkBindingHttp.ts";

/**
 * HTTP implementation of {@link GetFolderBackflushJob}.
 *
 * @layer
 * @provides Stackit.Telemetry.GetFolderBackflushJob
 */
export const GetFolderBackflushJobHttp = Layer.effect(
  GetFolderBackflushJob,
  makeFolderLinkHttpBinding({
    tag: "Stackit.Telemetry.GetFolderBackflushJob",
    permission: "telemetry-link.instance.get",
    operation: telemetry.getFolderBackflushJob,
  }),
);
