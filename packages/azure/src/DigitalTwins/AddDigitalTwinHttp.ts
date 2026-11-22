import * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Layer from "effect/Layer";
import { AddDigitalTwin } from "./AddDigitalTwin.ts";
import { DigitalTwinsRole, makeDigitalTwinsHttpBinding } from "./BindingHttp.ts";

/**
 * Implementation of {@link AddDigitalTwin} over the distilled `digitaltwins-data`
 * data plane. Assigns the custom `AzureDigitalTwinsTwinWriteRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DigitalTwins.AddDigitalTwin
 */
export const AddDigitalTwinHttp = Layer.effect(
  AddDigitalTwin,
  makeDigitalTwinsHttpBinding({
    tag: "Azure.DigitalTwins.AddDigitalTwin",
    operation: dt.AddDigitalTwin,
    grant: DigitalTwinsRole.TwinWrite,
  }),
);
