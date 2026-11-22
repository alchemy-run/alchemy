import * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Layer from "effect/Layer";
import { makeProjectUserHttpBinding, DevCenterRole } from "./BindingHttp.ts";
import { CreateDevBox } from "./CreateDevBox.ts";

/**
 * Implementation of {@link CreateDevBox} over the distilled `devcenter-data`
 * data plane. Assigns the custom `AzureDevCenterDevBoxWriteRole` on the
 * project.
 *
 * @layer
 * @provides Azure.DevCenter.CreateDevBox
 */
export const CreateDevBoxHttp = Layer.effect(
  CreateDevBox,
  makeProjectUserHttpBinding({
    tag: "Azure.DevCenter.CreateDevBox",
    operation: devcenter.CreateDevBoxDevBox,
    grants: [DevCenterRole.DevBoxWrite],
  }),
);
