import * as telemetry from "@distilled.cloud/stackit/telemetry_link";
import * as Layer from "effect/Layer";
import { makeFolderLinkHttpBinding } from "./LinkBindingHttp.ts";
import { ListFolderBackflushJobs } from "./ListFolderBackflushJobs.ts";

/**
 * HTTP implementation of {@link ListFolderBackflushJobs}.
 *
 * @layer
 * @provides Stackit.Telemetry.ListFolderBackflushJobs
 */
export const ListFolderBackflushJobsHttp = Layer.effect(
  ListFolderBackflushJobs,
  makeFolderLinkHttpBinding({
    tag: "Stackit.Telemetry.ListFolderBackflushJobs",
    permission: "telemetry-link.instance.get",
    operation: telemetry.listFolderBackflushJobs,
  }),
);
