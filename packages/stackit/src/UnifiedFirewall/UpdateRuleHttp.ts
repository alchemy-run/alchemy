import * as ufw from "@distilled.cloud/stackit/ufw";
import * as Layer from "effect/Layer";
import { makeRulesHttpBinding } from "./BindingHttp.ts";
import { UpdateRule } from "./UpdateRule.ts";

/**
 * HTTP implementation of {@link UpdateRule}.
 *
 * @layer
 * @provides Stackit.UnifiedFirewall.UpdateRule
 */
export const UpdateRuleHttp = Layer.effect(
  UpdateRule,
  makeRulesHttpBinding({
    tag: "Stackit.UnifiedFirewall.UpdateRule",
    access: { permissions: ["ufw.instance.update"] },
    operation: ufw.updateRule,
  }),
);
