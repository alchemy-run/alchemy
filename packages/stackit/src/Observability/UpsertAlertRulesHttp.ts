import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_WRITE_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { UpsertAlertRules } from "./UpsertAlertRules.ts";

/**
 * HTTP implementation of {@link UpsertAlertRules}.
 *
 * @layer
 * @provides Stackit.Observability.UpsertAlertRules
 */
export const UpsertAlertRulesHttp = Layer.effect(
  UpsertAlertRules,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.UpsertAlertRules",
    access: INSTANCE_WRITE_ACCESS,
    operation: observability.partialUpdateAlertrules,
  }),
);
