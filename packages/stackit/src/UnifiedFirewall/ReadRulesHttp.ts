import * as Layer from "effect/Layer";
import {
  READ_RULES_ACCESS,
  makeReadRulesClient,
  makeRulesClientHttpBinding,
} from "./BindingHttp.ts";
import { ReadRules } from "./ReadRules.ts";

/**
 * HTTP implementation of {@link ReadRules}.
 *
 * @layer
 * @provides Stackit.UnifiedFirewall.ReadRules
 */
export const ReadRulesHttp = Layer.effect(
  ReadRules,
  makeRulesClientHttpBinding({
    tag: "Stackit.UnifiedFirewall.ReadRules",
    access: READ_RULES_ACCESS,
    makeClient: makeReadRulesClient,
  }),
);
