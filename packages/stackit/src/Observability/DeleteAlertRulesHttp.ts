import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_WRITE_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { DeleteAlertRules } from "./DeleteAlertRules.ts";

/**
 * HTTP implementation of {@link DeleteAlertRules}.
 *
 * @layer
 * @provides Stackit.Observability.DeleteAlertRules
 */
export const DeleteAlertRulesHttp = Layer.effect(
  DeleteAlertRules,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.DeleteAlertRules",
    access: INSTANCE_WRITE_ACCESS,
    operation: observability.deleteAlertrules,
  }),
);
