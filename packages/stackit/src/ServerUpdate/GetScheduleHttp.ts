import * as serverUpdate from "@distilled.cloud/stackit/server_update";
import * as Layer from "effect/Layer";
import { makeScheduleHttpBinding } from "./BindingHttp.ts";
import { GetSchedule } from "./GetSchedule.ts";

/**
 * HTTP implementation of {@link GetSchedule}.
 *
 * @layer
 * @provides Stackit.ServerUpdate.GetSchedule
 */
export const GetScheduleHttp = Layer.effect(
  GetSchedule,
  makeScheduleHttpBinding({
    tag: "Stackit.ServerUpdate.GetSchedule",
    access: { permissions: ["server-update.update-schedule.get"] },
    operation: serverUpdate.getUpdateSchedule,
  }),
);
