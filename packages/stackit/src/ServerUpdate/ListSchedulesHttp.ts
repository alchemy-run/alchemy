import * as serverUpdate from "@distilled.cloud/stackit/server_update";
import * as Layer from "effect/Layer";
import { makeServerHttpBinding } from "./BindingHttp.ts";
import { ListSchedules } from "./ListSchedules.ts";

/**
 * HTTP implementation of {@link ListSchedules}.
 *
 * @layer
 * @provides Stackit.ServerUpdate.ListSchedules
 */
export const ListSchedulesHttp = Layer.effect(
  ListSchedules,
  makeServerHttpBinding({
    tag: "Stackit.ServerUpdate.ListSchedules",
    access: { permissions: ["server-update.update-schedule.list"] },
    operation: serverUpdate.listUpdateSchedules,
  }),
);
