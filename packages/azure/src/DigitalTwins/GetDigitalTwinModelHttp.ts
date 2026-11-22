import * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Layer from "effect/Layer";
import { DigitalTwinsRole, makeDigitalTwinsHttpBinding } from "./BindingHttp.ts";
import { GetDigitalTwinModel } from "./GetDigitalTwinModel.ts";

/**
 * Implementation of {@link GetDigitalTwinModel} over the distilled `digitaltwins-data`
 * data plane. Assigns the custom `AzureDigitalTwinsModelReadRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DigitalTwins.GetDigitalTwinModel
 */
export const GetDigitalTwinModelHttp = Layer.effect(
  GetDigitalTwinModel,
  makeDigitalTwinsHttpBinding({
    tag: "Azure.DigitalTwins.GetDigitalTwinModel",
    operation: dt.GetDigitalTwinModelById,
    grant: DigitalTwinsRole.ModelRead,
  }),
);
