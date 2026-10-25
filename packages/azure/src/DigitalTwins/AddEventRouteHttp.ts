import * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Layer from "effect/Layer";
import { AddEventRoute } from "./AddEventRoute.ts";
import { DigitalTwinsRole, makeDigitalTwinsHttpBinding } from "./BindingHttp.ts";

/**
 * Implementation of {@link AddEventRoute} over the distilled `digitaltwins-data`
 * data plane. Assigns the custom `AzureDigitalTwinsEventRouteWriteRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DigitalTwins.AddEventRoute
 */
export const AddEventRouteHttp = Layer.effect(
  AddEventRoute,
  makeDigitalTwinsHttpBinding({
    tag: "Azure.DigitalTwins.AddEventRoute",
    operation: dt.AddEventRoute,
    grant: DigitalTwinsRole.EventRouteWrite,
  }),
);
