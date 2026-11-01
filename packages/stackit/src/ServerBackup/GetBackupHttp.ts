import * as serverBackup from "@distilled.cloud/stackit/server_backup";
import * as Layer from "effect/Layer";
import { makeServerHttpBinding } from "./BindingHttp.ts";
import { GetBackup } from "./GetBackup.ts";

/**
 * HTTP implementation of {@link GetBackup}.
 *
 * @layer
 * @provides Stackit.ServerBackup.GetBackup
 */
export const GetBackupHttp = Layer.effect(
  GetBackup,
  makeServerHttpBinding({
    tag: "Stackit.ServerBackup.GetBackup",
    access: { permissions: ["server-backup.backup.get"] },
    operation: serverBackup.getBackup,
  }),
);
