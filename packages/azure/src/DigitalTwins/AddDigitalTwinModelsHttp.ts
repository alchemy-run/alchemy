import * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Layer from "effect/Layer";
import { AddDigitalTwinModels } from "./AddDigitalTwinModels.ts";
import { DigitalTwinsRole, makeDigitalTwinsHttpBinding } from "./BindingHttp.ts";

/**
 * Implementation of {@link AddDigitalTwinModels} over the distilled `digitaltwins-data`
 * data plane. Assigns the custom `AzureDigitalTwinsModelWriteRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DigitalTwins.AddDigitalTwinModels
 */
export const AddDigitalTwinModelsHttp = Layer.effect(
  AddDigitalTwinModels,
  makeDigitalTwinsHttpBinding({
    tag: "Azure.DigitalTwins.AddDigitalTwinModels",
    operation: dt.AddDigitalTwinModel,
    grant: DigitalTwinsRole.ModelWrite,
  }),
);
