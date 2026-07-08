import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Rule } from "./Rule.ts";

export interface DescribeRuleRequest extends Omit<
  eventbridge.DescribeRuleRequest,
  "Name" | "EventBusName"
> {}

/** @binding */
export interface DescribeRule extends Binding.Service<
  DescribeRule,
  "AWS.EventBridge.DescribeRule",
  (
    rule: Rule,
  ) => Effect.Effect<
    (
      request?: DescribeRuleRequest,
    ) => Effect.Effect<
      eventbridge.DescribeRuleResponse,
      eventbridge.DescribeRuleError
    >
  >
> {}
export const DescribeRule = Binding.Service<DescribeRule>(
  "AWS.EventBridge.DescribeRule",
);
