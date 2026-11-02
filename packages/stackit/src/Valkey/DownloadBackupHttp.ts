import * as valkey from "@distilled.cloud/stackit/valkey";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { DownloadBackup } from "./DownloadBackup.ts";

/**
 * HTTP implementation of {@link DownloadBackup}.
 *
 * @layer
 * @provides Stackit.Valkey.DownloadBackup
 */
export const DownloadBackupHttp = Layer.effect(
  DownloadBackup,
  makeInstanceHttpBinding({
    tag: "Stackit.Valkey.DownloadBackup",
    permission: "key-value-store.proxy.read",
    operation: valkey.downloadBackup,
  }),
);
