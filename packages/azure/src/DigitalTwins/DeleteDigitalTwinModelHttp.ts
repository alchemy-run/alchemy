import * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Layer from "effect/Layer";
import { DigitalTwinsRole, makeDigitalTwinsHttpBinding } from "./BindingHttp.ts";
import { DeleteDigitalTwinModel } from "./DeleteDigitalTwinModel.ts";

/**
 * Implementation of {@link DeleteDigitalTwinModel} over the distilled `digitaltwins-data`
 * data plane. Assigns the custom `AzureDigitalTwinsModelDeleteRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DigitalTwins.DeleteDigitalTwinModel
 */
export const DeleteDigitalTwinModelHttp = Layer.effect(
  DeleteDigitalTwinModel,
  makeDigitalTwinsHttpBinding({
    tag: "Azure.DigitalTwins.DeleteDigitalTwinModel",
    operation: dt.DeleteDigitalTwinModel,
    grant: DigitalTwinsRole.ModelDelete,
  }),
);
