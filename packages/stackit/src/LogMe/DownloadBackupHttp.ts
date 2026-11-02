import * as logme from "@distilled.cloud/stackit/logme";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { DownloadBackup } from "./DownloadBackup.ts";

/**
 * HTTP implementation of {@link DownloadBackup}.
 *
 * @layer
 * @provides Stackit.LogMe.DownloadBackup
 */
export const DownloadBackupHttp = Layer.effect(
  DownloadBackup,
  makeInstanceHttpBinding({
    tag: "Stackit.LogMe.DownloadBackup",
    permission: "logme.proxy.read",
    operation: logme.downloadBackup,
  }),
);
