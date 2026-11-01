import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_READ_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { GetAlertRule } from "./GetAlertRule.ts";

/**
 * HTTP implementation of {@link GetAlertRule}.
 *
 * @layer
 * @provides Stackit.Observability.GetAlertRule
 */
export const GetAlertRuleHttp = Layer.effect(
  GetAlertRule,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.GetAlertRule",
    access: INSTANCE_READ_ACCESS,
    operation: observability.getAlertrule,
  }),
);
