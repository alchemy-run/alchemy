import * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Layer from "effect/Layer";
import { DigitalTwinsRole, makeDigitalTwinsHttpBinding } from "./BindingHttp.ts";
import { GetEventRoute } from "./GetEventRoute.ts";

/**
 * Implementation of {@link GetEventRoute} over the distilled `digitaltwins-data`
 * data plane. Assigns the custom `AzureDigitalTwinsEventRouteReadRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DigitalTwins.GetEventRoute
 */
export const GetEventRouteHttp = Layer.effect(
  GetEventRoute,
  makeDigitalTwinsHttpBinding({
    tag: "Azure.DigitalTwins.GetEventRoute",
    operation: dt.GetEventRouteById,
    grant: DigitalTwinsRole.EventRouteRead,
  }),
);
