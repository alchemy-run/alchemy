import * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Layer from "effect/Layer";
import { makeProjectHttpBinding, DevCenterRole } from "./BindingHttp.ts";
import { ListSchedulesByPool } from "./ListSchedulesByPool.ts";

/**
 * Implementation of {@link ListSchedulesByPool} over the distilled
 * `devcenter-data` data plane. Assigns the custom
 * `AzureDevCenterScheduleReadRole` on the project.
 *
 * @layer
 * @provides Azure.DevCenter.ListSchedulesByPool
 */
export const ListSchedulesByPoolHttp = Layer.effect(
  ListSchedulesByPool,
  makeProjectHttpBinding({
    tag: "Azure.DevCenter.ListSchedulesByPool",
    operation: devcenter.ListDevBoxSchedulesByPool,
    grants: [DevCenterRole.ScheduleRead],
  }),
);
