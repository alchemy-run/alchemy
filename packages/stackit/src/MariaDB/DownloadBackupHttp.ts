import * as mariadb from "@distilled.cloud/stackit/mariadb";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { DownloadBackup } from "./DownloadBackup.ts";

/**
 * HTTP implementation of {@link DownloadBackup}.
 *
 * @layer
 * @provides Stackit.MariaDB.DownloadBackup
 */
export const DownloadBackupHttp = Layer.effect(
  DownloadBackup,
  makeInstanceHttpBinding({
    tag: "Stackit.MariaDB.DownloadBackup",
    permission: "mariadb.proxy.read",
    operation: mariadb.downloadBackup,
  }),
);
