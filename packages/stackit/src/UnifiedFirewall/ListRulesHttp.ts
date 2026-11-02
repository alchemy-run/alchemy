import * as ufw from "@distilled.cloud/stackit/ufw";
import * as Layer from "effect/Layer";
import { makeRulesHttpBinding } from "./BindingHttp.ts";
import { ListRules } from "./ListRules.ts";

/**
 * HTTP implementation of {@link ListRules}.
 *
 * @layer
 * @provides Stackit.UnifiedFirewall.ListRules
 */
export const ListRulesHttp = Layer.effect(
  ListRules,
  makeRulesHttpBinding({
    tag: "Stackit.UnifiedFirewall.ListRules",
    access: { permissions: ["ufw.instance.list"] },
    operation: ufw.listRules,
  }),
);
