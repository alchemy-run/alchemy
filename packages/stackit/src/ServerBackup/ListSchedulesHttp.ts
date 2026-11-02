import * as serverBackup from "@distilled.cloud/stackit/server_backup";
import * as Layer from "effect/Layer";
import { makeServerHttpBinding } from "./BindingHttp.ts";
import { ListSchedules } from "./ListSchedules.ts";

/**
 * HTTP implementation of {@link ListSchedules}.
 *
 * @layer
 * @provides Stackit.ServerBackup.ListSchedules
 */
export const ListSchedulesHttp = Layer.effect(
  ListSchedules,
  makeServerHttpBinding({
    tag: "Stackit.ServerBackup.ListSchedules",
    access: { permissions: ["server-backup.backup-schedule.list"] },
    operation: serverBackup.listBackupSchedules,
  }),
);
