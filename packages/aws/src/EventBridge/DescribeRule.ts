import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeEventBridgeRuleHttpBinding } from "./BindingHttp.ts";
import type { Rule } from "./Rule.ts";

export interface DescribeRuleRequest extends Omit<
  eventbridge.DescribeRuleRequest,
  "Name" | "EventBusName"
> {}

/**
 * Reads the configuration of an EventBridge rule (`events:DescribeRule`).
 *
 * Bind this operation to a {@link Rule} inside a function runtime to get a
 * callable that automatically injects the rule and bus names. Provide the
 * `DescribeRuleHttp` layer on the Function to satisfy the binding.
 * ### Describing Rules
 * **Example:** Describe the Bound Rule
 * ```typescript
 * // init — bind the rule (provide AWS.EventBridge.DescribeRuleHttp on the Function)
 * const describeRule = yield* AWS.EventBridge.DescribeRule(rule);
 *
 * // runtime — read the rule's state and pattern
 * const info = yield* describeRule();
 * console.log(info.State, info.EventPattern);
 * ```
 *
 * @binding
 */
export interface DescribeRule extends Binding.Service<
  DescribeRule,
  "AWS.EventBridge.DescribeRule",
  (
    rule: Rule,
  ) => Effect.Effect<
    (
      request?: DescribeRuleRequest,
    ) => Effect.Effect<eventbridge.DescribeRuleResponse, eventbridge.DescribeRuleError>
  >
> {}
export const DescribeRule = Binding.Service<DescribeRule>("AWS.EventBridge.DescribeRule");

/**
 * HTTP implementation of {@link DescribeRule}. At deploy time it grants
 * `events:DescribeRule` on the bound rule; at runtime it calls the
 * EventBridge API with the host Function's credentials. Provide this layer on
 * the Function using the binding.
 */
export const DescribeRuleHttp = Layer.effect(
  DescribeRule,
  makeEventBridgeRuleHttpBinding({
    tag: "AWS.EventBridge.DescribeRule",
    operation: eventbridge.describeRule,
    actions: ["events:DescribeRule"],
    ruleNameKey: "Name",
  }),
);
