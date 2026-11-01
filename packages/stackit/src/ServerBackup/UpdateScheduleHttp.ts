import * as serverBackup from "@distilled.cloud/stackit/server_backup";
import * as Layer from "effect/Layer";
import { makeScheduleHttpBinding } from "./BindingHttp.ts";
import { UpdateSchedule } from "./UpdateSchedule.ts";

/**
 * HTTP implementation of {@link UpdateSchedule}.
 *
 * @layer
 * @provides Stackit.ServerBackup.UpdateSchedule
 */
export const UpdateScheduleHttp = Layer.effect(
  UpdateSchedule,
  makeScheduleHttpBinding({
    tag: "Stackit.ServerBackup.UpdateSchedule",
    access: { permissions: ["server-backup.backup-schedule.update"] },
    operation: serverBackup.updateBackupSchedule,
  }),
);
