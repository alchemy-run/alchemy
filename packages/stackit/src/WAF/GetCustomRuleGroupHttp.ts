import * as waf from "@distilled.cloud/stackit/alb_waf";
import * as Layer from "effect/Layer";
import { makeCustomRuleGroupHttpBinding } from "./BindingHttp.ts";
import { GetCustomRuleGroup } from "./GetCustomRuleGroup.ts";

/**
 * HTTP implementation of {@link GetCustomRuleGroup}.
 *
 * @layer
 * @provides Stackit.WAF.GetCustomRuleGroup
 */
export const GetCustomRuleGroupHttp = Layer.effect(
  GetCustomRuleGroup,
  makeCustomRuleGroupHttpBinding({
    tag: "Stackit.WAF.GetCustomRuleGroup",
    access: { permissions: ["alb.waf.crg.get"] },
    operation: waf.getCustomRuleGroup,
  }),
);
