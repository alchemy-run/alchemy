import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_WRITE_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { UpdateAlertConfigRoute } from "./UpdateAlertConfigRoute.ts";

/**
 * HTTP implementation of {@link UpdateAlertConfigRoute}.
 *
 * @layer
 * @provides Stackit.Observability.UpdateAlertConfigRoute
 */
export const UpdateAlertConfigRouteHttp = Layer.effect(
  UpdateAlertConfigRoute,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.UpdateAlertConfigRoute",
    access: INSTANCE_WRITE_ACCESS,
    operation: observability.updateAlertConfigRoute,
  }),
);
