import * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Layer from "effect/Layer";
import { DigitalTwinsRole, makeDigitalTwinsHttpBinding } from "./BindingHttp.ts";
import { UpdateDigitalTwinModel } from "./UpdateDigitalTwinModel.ts";

/**
 * Implementation of {@link UpdateDigitalTwinModel} over the distilled `digitaltwins-data`
 * data plane. Assigns the custom `AzureDigitalTwinsModelWriteRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DigitalTwins.UpdateDigitalTwinModel
 */
export const UpdateDigitalTwinModelHttp = Layer.effect(
  UpdateDigitalTwinModel,
  makeDigitalTwinsHttpBinding({
    tag: "Azure.DigitalTwins.UpdateDigitalTwinModel",
    operation: dt.UpdateDigitalTwinModel,
    grant: DigitalTwinsRole.ModelWrite,
  }),
);
