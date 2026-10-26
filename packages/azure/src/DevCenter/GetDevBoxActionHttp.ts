import * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Layer from "effect/Layer";
import { makeProjectUserHttpBinding, DevCenterRole } from "./BindingHttp.ts";
import { GetDevBoxAction } from "./GetDevBoxAction.ts";

/**
 * Implementation of {@link GetDevBoxAction} over the distilled `devcenter-data`
 * data plane. Assigns the custom `AzureDevCenterDevBoxActionReadRole` on the
 * project.
 *
 * @layer
 * @provides Azure.DevCenter.GetDevBoxAction
 */
export const GetDevBoxActionHttp = Layer.effect(
  GetDevBoxAction,
  makeProjectUserHttpBinding({
    tag: "Azure.DevCenter.GetDevBoxAction",
    operation: devcenter.GetDevBoxAction,
    grants: [DevCenterRole.DevBoxActionRead],
  }),
);
