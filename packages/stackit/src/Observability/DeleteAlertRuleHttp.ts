import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_WRITE_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { DeleteAlertRule } from "./DeleteAlertRule.ts";

/**
 * HTTP implementation of {@link DeleteAlertRule}.
 *
 * @layer
 * @provides Stackit.Observability.DeleteAlertRule
 */
export const DeleteAlertRuleHttp = Layer.effect(
  DeleteAlertRule,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.DeleteAlertRule",
    access: INSTANCE_WRITE_ACCESS,
    operation: observability.deleteAlertrule,
  }),
);
