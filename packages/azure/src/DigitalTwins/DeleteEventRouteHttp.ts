import * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Layer from "effect/Layer";
import { DigitalTwinsRole, makeDigitalTwinsHttpBinding } from "./BindingHttp.ts";
import { DeleteEventRoute } from "./DeleteEventRoute.ts";

/**
 * Implementation of {@link DeleteEventRoute} over the distilled `digitaltwins-data`
 * data plane. Assigns the custom `AzureDigitalTwinsEventRouteDeleteRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DigitalTwins.DeleteEventRoute
 */
export const DeleteEventRouteHttp = Layer.effect(
  DeleteEventRoute,
  makeDigitalTwinsHttpBinding({
    tag: "Azure.DigitalTwins.DeleteEventRoute",
    operation: dt.DeleteEventRoute,
    grant: DigitalTwinsRole.EventRouteDelete,
  }),
);
