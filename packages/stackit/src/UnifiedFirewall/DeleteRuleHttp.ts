import * as ufw from "@distilled.cloud/stackit/ufw";
import * as Layer from "effect/Layer";
import { makeRulesHttpBinding } from "./BindingHttp.ts";
import { DeleteRule } from "./DeleteRule.ts";

/**
 * HTTP implementation of {@link DeleteRule}.
 *
 * @layer
 * @provides Stackit.UnifiedFirewall.DeleteRule
 */
export const DeleteRuleHttp = Layer.effect(
  DeleteRule,
  makeRulesHttpBinding({
    tag: "Stackit.UnifiedFirewall.DeleteRule",
    access: { permissions: ["ufw.instance.delete"] },
    operation: ufw.deleteRule,
  }),
);
