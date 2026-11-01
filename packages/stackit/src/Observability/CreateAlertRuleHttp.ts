import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_WRITE_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { CreateAlertRule } from "./CreateAlertRule.ts";

/**
 * HTTP implementation of {@link CreateAlertRule}.
 *
 * @layer
 * @provides Stackit.Observability.CreateAlertRule
 */
export const CreateAlertRuleHttp = Layer.effect(
  CreateAlertRule,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.CreateAlertRule",
    access: INSTANCE_WRITE_ACCESS,
    operation: observability.createAlertrules,
  }),
);
