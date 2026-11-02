import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_WRITE_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { UpdateAlertRule } from "./UpdateAlertRule.ts";

/**
 * HTTP implementation of {@link UpdateAlertRule}.
 *
 * @layer
 * @provides Stackit.Observability.UpdateAlertRule
 */
export const UpdateAlertRuleHttp = Layer.effect(
  UpdateAlertRule,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.UpdateAlertRule",
    access: INSTANCE_WRITE_ACCESS,
    operation: observability.updateAlertrule,
  }),
);
