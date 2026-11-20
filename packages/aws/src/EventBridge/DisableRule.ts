import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeEventBridgeRuleHttpBinding } from "./BindingHttp.ts";
import type { Rule } from "./Rule.ts";

/**
 * Disables an EventBridge rule (`events:DisableRule`) so it stops matching
 * events without deleting it.
 *
 * Bind this operation to a {@link Rule} inside a function runtime to get a
 * callable that pauses the rule — the runtime half of a feature toggle or
 * kill switch. Provide the `DisableRuleHttp` layer on the Function to
 * satisfy the binding.
 * ### Toggling Rules
 * **Example:** Pause the Bound Rule
 * ```typescript
 * // init — bind the rule (provide AWS.EventBridge.DisableRuleHttp on the Function)
 * const disableRule = yield* AWS.EventBridge.DisableRule(rule);
 *
 * // runtime — stop event routing until re-enabled
 * yield* disableRule();
 * ```
 *
 * @binding
 */
export interface DisableRule extends Binding.Service<
  DisableRule,
  "AWS.EventBridge.DisableRule",
  (
    rule: Rule,
  ) => Effect.Effect<
    () => Effect.Effect<eventbridge.DisableRuleResponse, eventbridge.DisableRuleError>
  >
> {}
export const DisableRule = Binding.Service<DisableRule>("AWS.EventBridge.DisableRule");

/**
 * HTTP implementation of {@link DisableRule}. At deploy time it grants
 * `events:DisableRule` on the bound rule; at runtime it calls the EventBridge
 * API with the host Function's credentials. Provide this layer on the
 * Function using the binding.
 */
export const DisableRuleHttp = Layer.effect(
  DisableRule,
  makeEventBridgeRuleHttpBinding({
    tag: "AWS.EventBridge.DisableRule",
    operation: eventbridge.disableRule,
    actions: ["events:DisableRule"],
    ruleNameKey: "Name",
  }),
);
