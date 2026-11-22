import * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Layer from "effect/Layer";
import { makeProjectHttpBinding, DevCenterRole } from "./BindingHttp.ts";
import { ListSchedules } from "./ListSchedules.ts";

/**
 * Implementation of {@link ListSchedules} over the distilled `devcenter-data`
 * data plane. Assigns the custom `AzureDevCenterScheduleReadRole` on the
 * project.
 *
 * @layer
 * @provides Azure.DevCenter.ListSchedules
 */
export const ListSchedulesHttp = Layer.effect(
  ListSchedules,
  makeProjectHttpBinding({
    tag: "Azure.DevCenter.ListSchedules",
    operation: devcenter.ListDevBoxSchedulesByProject,
    grants: [DevCenterRole.ScheduleRead],
  }),
);
