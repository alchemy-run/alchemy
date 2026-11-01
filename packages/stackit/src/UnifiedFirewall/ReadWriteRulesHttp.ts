import * as Layer from "effect/Layer";
import {
  READ_WRITE_RULES_ACCESS,
  makeReadWriteRulesClient,
  makeRulesClientHttpBinding,
} from "./BindingHttp.ts";
import { ReadWriteRules } from "./ReadWriteRules.ts";

/**
 * HTTP implementation of {@link ReadWriteRules}.
 *
 * @layer
 * @provides Stackit.UnifiedFirewall.ReadWriteRules
 */
export const ReadWriteRulesHttp = Layer.effect(
  ReadWriteRules,
  makeRulesClientHttpBinding({
    tag: "Stackit.UnifiedFirewall.ReadWriteRules",
    access: READ_WRITE_RULES_ACCESS,
    makeClient: makeReadWriteRulesClient,
  }),
);
