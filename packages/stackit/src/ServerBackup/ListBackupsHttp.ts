import * as serverBackup from "@distilled.cloud/stackit/server_backup";
import * as Layer from "effect/Layer";
import { makeServerHttpBinding } from "./BindingHttp.ts";
import { ListBackups } from "./ListBackups.ts";

/**
 * HTTP implementation of {@link ListBackups}.
 *
 * @layer
 * @provides Stackit.ServerBackup.ListBackups
 */
export const ListBackupsHttp = Layer.effect(
  ListBackups,
  makeServerHttpBinding({
    tag: "Stackit.ServerBackup.ListBackups",
    access: { permissions: ["server-backup.backup.list"] },
    operation: serverBackup.listBackups,
  }),
);
