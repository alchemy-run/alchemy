import * as Layer from "effect/Layer";
import {
  WRITE_RULES_ACCESS,
  makeWriteRulesClient,
  makeRulesClientHttpBinding,
} from "./BindingHttp.ts";
import { WriteRules } from "./WriteRules.ts";

/**
 * HTTP implementation of {@link WriteRules}.
 *
 * @layer
 * @provides Stackit.UnifiedFirewall.WriteRules
 */
export const WriteRulesHttp = Layer.effect(
  WriteRules,
  makeRulesClientHttpBinding({
    tag: "Stackit.UnifiedFirewall.WriteRules",
    access: WRITE_RULES_ACCESS,
    makeClient: makeWriteRulesClient,
  }),
);
