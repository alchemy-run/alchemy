import * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Layer from "effect/Layer";
import { DigitalTwinsRole, makeDigitalTwinsHttpBinding } from "./BindingHttp.ts";
import { DeleteDigitalTwin } from "./DeleteDigitalTwin.ts";

/**
 * Implementation of {@link DeleteDigitalTwin} over the distilled `digitaltwins-data`
 * data plane. Assigns the custom `AzureDigitalTwinsTwinDeleteRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DigitalTwins.DeleteDigitalTwin
 */
export const DeleteDigitalTwinHttp = Layer.effect(
  DeleteDigitalTwin,
  makeDigitalTwinsHttpBinding({
    tag: "Azure.DigitalTwins.DeleteDigitalTwin",
    operation: dt.DeleteDigitalTwin,
    grant: DigitalTwinsRole.TwinDelete,
  }),
);
