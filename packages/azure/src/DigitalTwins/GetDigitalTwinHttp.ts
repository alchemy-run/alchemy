import * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Layer from "effect/Layer";
import { DigitalTwinsRole, makeDigitalTwinsHttpBinding } from "./BindingHttp.ts";
import { GetDigitalTwin } from "./GetDigitalTwin.ts";

/**
 * Implementation of {@link GetDigitalTwin} over the distilled `digitaltwins-data`
 * data plane. Assigns the custom `AzureDigitalTwinsTwinReadRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DigitalTwins.GetDigitalTwin
 */
export const GetDigitalTwinHttp = Layer.effect(
  GetDigitalTwin,
  makeDigitalTwinsHttpBinding({
    tag: "Azure.DigitalTwins.GetDigitalTwin",
    operation: dt.GetDigitalTwinById,
    grant: DigitalTwinsRole.TwinRead,
  }),
);
