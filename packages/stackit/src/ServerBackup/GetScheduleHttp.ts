import * as serverBackup from "@distilled.cloud/stackit/server_backup";
import * as Layer from "effect/Layer";
import { makeScheduleHttpBinding } from "./BindingHttp.ts";
import { GetSchedule } from "./GetSchedule.ts";

/**
 * HTTP implementation of {@link GetSchedule}.
 *
 * @layer
 * @provides Stackit.ServerBackup.GetSchedule
 */
export const GetScheduleHttp = Layer.effect(
  GetSchedule,
  makeScheduleHttpBinding({
    tag: "Stackit.ServerBackup.GetSchedule",
    access: { permissions: ["server-backup.backup-schedule.get"] },
    operation: serverBackup.getBackupSchedule,
  }),
);
