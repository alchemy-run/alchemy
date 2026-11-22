import * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Layer from "effect/Layer";
import { DigitalTwinsRole, makeDigitalTwinsHttpBinding } from "./BindingHttp.ts";
import { GetDigitalTwinComponent } from "./GetDigitalTwinComponent.ts";

/**
 * Implementation of {@link GetDigitalTwinComponent} over the distilled `digitaltwins-data`
 * data plane. Assigns the custom `AzureDigitalTwinsTwinReadRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DigitalTwins.GetDigitalTwinComponent
 */
export const GetDigitalTwinComponentHttp = Layer.effect(
  GetDigitalTwinComponent,
  makeDigitalTwinsHttpBinding({
    tag: "Azure.DigitalTwins.GetDigitalTwinComponent",
    operation: dt.GetDigitalTwinComponent,
    grant: DigitalTwinsRole.TwinRead,
  }),
);
