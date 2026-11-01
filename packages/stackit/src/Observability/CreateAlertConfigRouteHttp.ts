import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_WRITE_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { CreateAlertConfigRoute } from "./CreateAlertConfigRoute.ts";

/**
 * HTTP implementation of {@link CreateAlertConfigRoute}.
 *
 * @layer
 * @provides Stackit.Observability.CreateAlertConfigRoute
 */
export const CreateAlertConfigRouteHttp = Layer.effect(
  CreateAlertConfigRoute,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.CreateAlertConfigRoute",
    access: INSTANCE_WRITE_ACCESS,
    operation: observability.createAlertConfigRoute,
  }),
);
