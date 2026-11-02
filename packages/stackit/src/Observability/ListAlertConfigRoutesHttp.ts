import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_READ_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ListAlertConfigRoutes } from "./ListAlertConfigRoutes.ts";

/**
 * HTTP implementation of {@link ListAlertConfigRoutes}.
 *
 * @layer
 * @provides Stackit.Observability.ListAlertConfigRoutes
 */
export const ListAlertConfigRoutesHttp = Layer.effect(
  ListAlertConfigRoutes,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.ListAlertConfigRoutes",
    access: INSTANCE_READ_ACCESS,
    operation: observability.listAlertConfigRoutes,
  }),
);
