import * as waf from "@distilled.cloud/stackit/alb_waf";
import * as Layer from "effect/Layer";
import { makeScopeHttpBinding } from "../LoadBalancer/BindingHttp.ts";
import { ListCustomRuleGroups } from "./ListCustomRuleGroups.ts";

/**
 * HTTP implementation of {@link ListCustomRuleGroups}.
 *
 * @layer
 * @provides Stackit.WAF.ListCustomRuleGroups
 */
export const ListCustomRuleGroupsHttp = Layer.effect(
  ListCustomRuleGroups,
  makeScopeHttpBinding({
    tag: "Stackit.WAF.ListCustomRuleGroups",
    access: { permissions: ["alb.waf.crg.list"] },
    operation: waf.listCustomRuleGroup,
  }),
);
