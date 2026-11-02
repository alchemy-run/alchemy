import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_READ_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ListAlertRules } from "./ListAlertRules.ts";

/**
 * HTTP implementation of {@link ListAlertRules}.
 *
 * @layer
 * @provides Stackit.Observability.ListAlertRules
 */
export const ListAlertRulesHttp = Layer.effect(
  ListAlertRules,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.ListAlertRules",
    access: INSTANCE_READ_ACCESS,
    operation: observability.listAlertrules,
  }),
);
