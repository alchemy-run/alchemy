import * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Layer from "effect/Layer";
import { DigitalTwinsRole, makeDigitalTwinsHttpBinding } from "./BindingHttp.ts";
import { ListDigitalTwinModels } from "./ListDigitalTwinModels.ts";

/**
 * Implementation of {@link ListDigitalTwinModels} over the distilled `digitaltwins-data`
 * data plane. Assigns the custom `AzureDigitalTwinsModelReadRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DigitalTwins.ListDigitalTwinModels
 */
export const ListDigitalTwinModelsHttp = Layer.effect(
  ListDigitalTwinModels,
  makeDigitalTwinsHttpBinding({
    tag: "Azure.DigitalTwins.ListDigitalTwinModels",
    operation: dt.ListDigitalTwinModels,
    grant: DigitalTwinsRole.ModelRead,
  }),
);
