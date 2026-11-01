import * as serverBackup from "@distilled.cloud/stackit/server_backup";
import * as Layer from "effect/Layer";
import { makeServerHttpBinding } from "./BindingHttp.ts";
import { RestoreBackup } from "./RestoreBackup.ts";

/**
 * HTTP implementation of {@link RestoreBackup}.
 *
 * @layer
 * @provides Stackit.ServerBackup.RestoreBackup
 */
export const RestoreBackupHttp = Layer.effect(
  RestoreBackup,
  makeServerHttpBinding({
    tag: "Stackit.ServerBackup.RestoreBackup",
    access: { permissions: ["server-backup.backup.restore"] },
    operation: serverBackup.restoreBackup,
  }),
);
