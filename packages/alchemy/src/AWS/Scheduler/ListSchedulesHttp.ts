import * as scheduler from "@distilled.cloud/aws/scheduler";
import * as Layer from "effect/Layer";
import { makeScheduleGroupScopedHttpBinding } from "./BindingHttp.ts";
import { ListSchedules } from "./ListSchedules.ts";

export const ListSchedulesHttp = Layer.effect(
  ListSchedules,
  makeScheduleGroupScopedHttpBinding({
    tag: "AWS.Scheduler.ListSchedules",
    operation: scheduler.listSchedules,
    actions: ["scheduler:ListSchedules"],
    // An absent GroupName on ListSchedules means "all groups", which would
    // escape the granted schedule/default/* scope — pin the default group.
    fallbackGroupName: "default",
  }),
);
