import * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Layer from "effect/Layer";
import { makeProjectHttpBinding, DevCenterRole } from "./BindingHttp.ts";
import { GetPool } from "./GetPool.ts";

/**
 * Implementation of {@link GetPool} over the distilled `devcenter-data` data
 * plane. Assigns the custom `AzureDevCenterPoolReadRole` on the project.
 *
 * @layer
 * @provides Azure.DevCenter.GetPool
 */
export const GetPoolHttp = Layer.effect(
  GetPool,
  makeProjectHttpBinding({
    tag: "Azure.DevCenter.GetPool",
    operation: devcenter.GetDevBoxPool,
    grants: [DevCenterRole.PoolRead],
  }),
);
