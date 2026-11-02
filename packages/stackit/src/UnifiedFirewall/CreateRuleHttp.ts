import * as ufw from "@distilled.cloud/stackit/ufw";
import * as Layer from "effect/Layer";
import { makeRulesHttpBinding } from "./BindingHttp.ts";
import { CreateRule } from "./CreateRule.ts";

/**
 * HTTP implementation of {@link CreateRule}.
 *
 * @layer
 * @provides Stackit.UnifiedFirewall.CreateRule
 */
export const CreateRuleHttp = Layer.effect(
  CreateRule,
  makeRulesHttpBinding({
    tag: "Stackit.UnifiedFirewall.CreateRule",
    access: { permissions: ["ufw.instance.create"] },
    operation: ufw.createRule,
  }),
);
