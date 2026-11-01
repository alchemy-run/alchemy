import * as waf from "@distilled.cloud/stackit/alb_waf";
import * as Layer from "effect/Layer";
import { makeCustomRuleGroupHttpBinding } from "./BindingHttp.ts";
import { UpdateCustomRuleGroup } from "./UpdateCustomRuleGroup.ts";

/**
 * HTTP implementation of {@link UpdateCustomRuleGroup}.
 *
 * @layer
 * @provides Stackit.WAF.UpdateCustomRuleGroup
 */
export const UpdateCustomRuleGroupHttp = Layer.effect(
  UpdateCustomRuleGroup,
  makeCustomRuleGroupHttpBinding({
    tag: "Stackit.WAF.UpdateCustomRuleGroup",
    access: { permissions: ["alb.waf.crg.update"] },
    operation: waf.updateCustomRuleGroup,
  }),
);
