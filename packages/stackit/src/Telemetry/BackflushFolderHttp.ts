import * as telemetry from "@distilled.cloud/stackit/telemetry_link";
import * as Layer from "effect/Layer";
import { BackflushFolder } from "./BackflushFolder.ts";
import { makeFolderLinkHttpBinding } from "./LinkBindingHttp.ts";

/**
 * HTTP implementation of {@link BackflushFolder}.
 *
 * @layer
 * @provides Stackit.Telemetry.BackflushFolder
 */
export const BackflushFolderHttp = Layer.effect(
  BackflushFolder,
  makeFolderLinkHttpBinding({
    tag: "Stackit.Telemetry.BackflushFolder",
    permission: "telemetry-link.instance.update",
    operation: telemetry.createFolderBackflushJob,
  }),
);
