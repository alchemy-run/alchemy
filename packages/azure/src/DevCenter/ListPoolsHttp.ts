import * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Layer from "effect/Layer";
import { makeProjectHttpBinding, DevCenterRole } from "./BindingHttp.ts";
import { ListPools } from "./ListPools.ts";

/**
 * Implementation of {@link ListPools} over the distilled `devcenter-data`
 * data plane. Assigns the custom `AzureDevCenterPoolReadRole` on the project.
 *
 * @layer
 * @provides Azure.DevCenter.ListPools
 */
export const ListPoolsHttp = Layer.effect(
  ListPools,
  makeProjectHttpBinding({
    tag: "Azure.DevCenter.ListPools",
    operation: devcenter.ListDevBoxPools,
    grants: [DevCenterRole.PoolRead],
  }),
);
