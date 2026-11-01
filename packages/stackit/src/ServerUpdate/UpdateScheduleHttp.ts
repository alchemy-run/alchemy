import * as serverUpdate from "@distilled.cloud/stackit/server_update";
import * as Layer from "effect/Layer";
import { makeScheduleHttpBinding } from "./BindingHttp.ts";
import { UpdateSchedule } from "./UpdateSchedule.ts";

/**
 * HTTP implementation of {@link UpdateSchedule}.
 *
 * @layer
 * @provides Stackit.ServerUpdate.UpdateSchedule
 */
export const UpdateScheduleHttp = Layer.effect(
  UpdateSchedule,
  makeScheduleHttpBinding({
    tag: "Stackit.ServerUpdate.UpdateSchedule",
    access: { permissions: ["server-update.update-schedule.update"] },
    operation: serverUpdate.updateUpdateSchedule,
  }),
);
