import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeEventBridgeRuleHttpBinding } from "./BindingHttp.ts";
import type { Rule } from "./Rule.ts";

export interface ListTargetsByRuleRequest extends Omit<
  eventbridge.ListTargetsByRuleRequest,
  "Rule" | "EventBusName"
> {}

/**
 * Lists the targets attached to an EventBridge rule
 * (`events:ListTargetsByRule`).
 *
 * Bind this operation to a {@link Rule} inside a function runtime to get a
 * callable that automatically injects the rule and bus names. Provide the
 * `ListTargetsByRuleHttp` layer on the Function to satisfy the binding.
 * ### Listing Targets
 * **Example:** List a Rule's Targets
 * ```typescript
 * // init — bind the rule (provide AWS.EventBridge.ListTargetsByRuleHttp on the Function)
 * const listTargets = yield* AWS.EventBridge.ListTargetsByRule(rule);
 *
 * // runtime — enumerate the rule's targets
 * const { Targets } = yield* listTargets();
 * ```
 *
 * @binding
 */
export interface ListTargetsByRule extends Binding.Service<
  ListTargetsByRule,
  "AWS.EventBridge.ListTargetsByRule",
  (
    rule: Rule,
  ) => Effect.Effect<
    (
      request?: ListTargetsByRuleRequest,
    ) => Effect.Effect<eventbridge.ListTargetsByRuleResponse, eventbridge.ListTargetsByRuleError>
  >
> {}
export const ListTargetsByRule = Binding.Service<ListTargetsByRule>(
  "AWS.EventBridge.ListTargetsByRule",
);

/**
 * HTTP implementation of {@link ListTargetsByRule}. At deploy time it grants
 * `events:ListTargetsByRule` on the bound rule; at runtime it calls the
 * EventBridge API with the host Function's credentials. Provide this layer on
 * the Function using the binding.
 */
export const ListTargetsByRuleHttp = Layer.effect(
  ListTargetsByRule,
  makeEventBridgeRuleHttpBinding({
    tag: "AWS.EventBridge.ListTargetsByRule",
    operation: eventbridge.listTargetsByRule,
    actions: ["events:ListTargetsByRule"],
    ruleNameKey: "Rule",
  }),
);
