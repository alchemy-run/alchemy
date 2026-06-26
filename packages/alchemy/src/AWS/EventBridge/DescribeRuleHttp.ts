import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import { DescribeRule, type DescribeRuleRequest } from "./DescribeRule.ts";
import type { Rule } from "./Rule.ts";

export const DescribeRuleHttp = Layer.effect(
  DescribeRule,
  Effect.gen(function* () {
    const describeRule = yield* eventbridge.describeRule;

    return Effect.fn(function* (rule: Rule) {
      const Name = yield* rule.ruleName;
      const EventBusName = yield* rule.eventBusName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.EventBridge.DescribeRule(${rule}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["events:DescribeRule"],
                  Resource: [rule.ruleArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.EventBridge.DescribeRule(${rule.LogicalId})`)(
        function* (request?: DescribeRuleRequest) {
          const name = yield* Name;
          const eventBusName = yield* EventBusName;
          return yield* describeRule({
            ...request,
            Name: name,
            EventBusName: eventBusName !== "default" ? eventBusName : undefined,
          });
        },
      );
    });
  }),
);
