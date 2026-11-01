import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_READ_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { GetAlertConfigRoute } from "./GetAlertConfigRoute.ts";

/**
 * HTTP implementation of {@link GetAlertConfigRoute}.
 *
 * @layer
 * @provides Stackit.Observability.GetAlertConfigRoute
 */
export const GetAlertConfigRouteHttp = Layer.effect(
  GetAlertConfigRoute,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.GetAlertConfigRoute",
    access: INSTANCE_READ_ACCESS,
    operation: observability.getAlertConfigRoute,
  }),
);
