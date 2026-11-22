import * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Layer from "effect/Layer";
import { makeProjectHttpBinding, DevCenterRole } from "./BindingHttp.ts";
import { GetScheduleByPool } from "./GetScheduleByPool.ts";

/**
 * Implementation of {@link GetScheduleByPool} over the distilled
 * `devcenter-data` data plane. Assigns the custom
 * `AzureDevCenterScheduleReadRole` on the project.
 *
 * @layer
 * @provides Azure.DevCenter.GetScheduleByPool
 */
export const GetScheduleByPoolHttp = Layer.effect(
  GetScheduleByPool,
  makeProjectHttpBinding({
    tag: "Azure.DevCenter.GetScheduleByPool",
    operation: devcenter.GetDevBoxScheduleByPool,
    grants: [DevCenterRole.ScheduleRead],
  }),
);
