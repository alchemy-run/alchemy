import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Rule } from "./Rule.ts";

export interface ListTargetsByRuleRequest extends Omit<
  eventbridge.ListTargetsByRuleRequest,
  "Rule" | "EventBusName"
> {}

/** @binding */
export interface ListTargetsByRule extends Binding.Service<
  ListTargetsByRule,
  "AWS.EventBridge.ListTargetsByRule",
  (
    rule: Rule,
  ) => Effect.Effect<
    (
      request?: ListTargetsByRuleRequest,
    ) => Effect.Effect<
      eventbridge.ListTargetsByRuleResponse,
      eventbridge.ListTargetsByRuleError
    >
  >
> {}
export const ListTargetsByRule = Binding.Service<ListTargetsByRule>(
  "AWS.EventBridge.ListTargetsByRule",
);
