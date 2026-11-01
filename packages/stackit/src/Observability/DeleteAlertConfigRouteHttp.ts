import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_WRITE_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { DeleteAlertConfigRoute } from "./DeleteAlertConfigRoute.ts";

/**
 * HTTP implementation of {@link DeleteAlertConfigRoute}.
 *
 * @layer
 * @provides Stackit.Observability.DeleteAlertConfigRoute
 */
export const DeleteAlertConfigRouteHttp = Layer.effect(
  DeleteAlertConfigRoute,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.DeleteAlertConfigRoute",
    access: INSTANCE_WRITE_ACCESS,
    operation: observability.deleteAlertConfigRoute,
  }),
);
