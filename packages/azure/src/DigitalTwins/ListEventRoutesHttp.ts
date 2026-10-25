import * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Layer from "effect/Layer";
import { DigitalTwinsRole, makeDigitalTwinsHttpBinding } from "./BindingHttp.ts";
import { ListEventRoutes } from "./ListEventRoutes.ts";

/**
 * Implementation of {@link ListEventRoutes} over the distilled `digitaltwins-data`
 * data plane. Assigns the custom `AzureDigitalTwinsEventRouteReadRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DigitalTwins.ListEventRoutes
 */
export const ListEventRoutesHttp = Layer.effect(
  ListEventRoutes,
  makeDigitalTwinsHttpBinding({
    tag: "Azure.DigitalTwins.ListEventRoutes",
    operation: dt.ListEventRoutes,
    grant: DigitalTwinsRole.EventRouteRead,
  }),
);
