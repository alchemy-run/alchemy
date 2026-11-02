import * as ufw from "@distilled.cloud/stackit/ufw";
import * as Layer from "effect/Layer";
import { makeRulesHttpBinding } from "./BindingHttp.ts";
import { GetRule } from "./GetRule.ts";

/**
 * HTTP implementation of {@link GetRule}.
 *
 * @layer
 * @provides Stackit.UnifiedFirewall.GetRule
 */
export const GetRuleHttp = Layer.effect(
  GetRule,
  makeRulesHttpBinding({
    tag: "Stackit.UnifiedFirewall.GetRule",
    access: { permissions: ["ufw.instance.get"] },
    operation: ufw.getRule,
  }),
);
