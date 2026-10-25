import * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Layer from "effect/Layer";
import { DigitalTwinsRole, makeDigitalTwinsHttpBinding } from "./BindingHttp.ts";
import { UpdateDigitalTwinComponent } from "./UpdateDigitalTwinComponent.ts";

/**
 * Implementation of {@link UpdateDigitalTwinComponent} over the distilled `digitaltwins-data`
 * data plane. Assigns the custom `AzureDigitalTwinsTwinWriteRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DigitalTwins.UpdateDigitalTwinComponent
 */
export const UpdateDigitalTwinComponentHttp = Layer.effect(
  UpdateDigitalTwinComponent,
  makeDigitalTwinsHttpBinding({
    tag: "Azure.DigitalTwins.UpdateDigitalTwinComponent",
    operation: dt.UpdateDigitalTwinComponent,
    grant: DigitalTwinsRole.TwinWrite,
  }),
);
