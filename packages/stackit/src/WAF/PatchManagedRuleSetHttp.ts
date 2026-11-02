import * as waf from "@distilled.cloud/stackit/alb_waf";
import * as Layer from "effect/Layer";
import { makeManagedRuleSetHttpBinding } from "./BindingHttp.ts";
import { PatchManagedRuleSet } from "./PatchManagedRuleSet.ts";

/**
 * HTTP implementation of {@link PatchManagedRuleSet}.
 *
 * @layer
 * @provides Stackit.WAF.PatchManagedRuleSet
 */
export const PatchManagedRuleSetHttp = Layer.effect(
  PatchManagedRuleSet,
  makeManagedRuleSetHttpBinding({
    tag: "Stackit.WAF.PatchManagedRuleSet",
    access: { permissions: ["alb.waf.mrs.update"] },
    operation: waf.patchManagedRuleSet,
  }),
);
