import * as waf from "@distilled.cloud/stackit/alb_waf";
import * as Layer from "effect/Layer";
import { makeManagedRuleSetHttpBinding } from "./BindingHttp.ts";
import { GetManagedRuleSet } from "./GetManagedRuleSet.ts";

/**
 * HTTP implementation of {@link GetManagedRuleSet}.
 *
 * @layer
 * @provides Stackit.WAF.GetManagedRuleSet
 */
export const GetManagedRuleSetHttp = Layer.effect(
  GetManagedRuleSet,
  makeManagedRuleSetHttpBinding({
    tag: "Stackit.WAF.GetManagedRuleSet",
    access: { permissions: ["alb.waf.mrs.get"] },
    operation: waf.getManagedRuleSet,
  }),
);
