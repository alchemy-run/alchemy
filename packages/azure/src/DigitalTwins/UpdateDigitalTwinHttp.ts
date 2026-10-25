import * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Layer from "effect/Layer";
import { DigitalTwinsRole, makeDigitalTwinsHttpBinding } from "./BindingHttp.ts";
import { UpdateDigitalTwin } from "./UpdateDigitalTwin.ts";

/**
 * Implementation of {@link UpdateDigitalTwin} over the distilled `digitaltwins-data`
 * data plane. Assigns the custom `AzureDigitalTwinsTwinWriteRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DigitalTwins.UpdateDigitalTwin
 */
export const UpdateDigitalTwinHttp = Layer.effect(
  UpdateDigitalTwin,
  makeDigitalTwinsHttpBinding({
    tag: "Azure.DigitalTwins.UpdateDigitalTwin",
    operation: dt.UpdateDigitalTwin,
    grant: DigitalTwinsRole.TwinWrite,
  }),
);
