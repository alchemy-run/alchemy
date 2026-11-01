import * as waf from "@distilled.cloud/stackit/alb_waf";
import * as Layer from "effect/Layer";
import { makeScopeHttpBinding } from "../LoadBalancer/BindingHttp.ts";
import { ListManagedRuleSets } from "./ListManagedRuleSets.ts";

/**
 * HTTP implementation of {@link ListManagedRuleSets}.
 *
 * @layer
 * @provides Stackit.WAF.ListManagedRuleSets
 */
export const ListManagedRuleSetsHttp = Layer.effect(
  ListManagedRuleSets,
  makeScopeHttpBinding({
    tag: "Stackit.WAF.ListManagedRuleSets",
    access: { permissions: ["alb.waf.mrs.list"] },
    operation: waf.listManagedRuleSets,
  }),
);
