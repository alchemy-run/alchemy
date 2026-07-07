import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import {
  ListTargetsByRule,
  type ListTargetsByRuleRequest,
} from "./ListTargetsByRule.ts";
import type { Rule } from "./Rule.ts";

export const ListTargetsByRuleHttp = Layer.effect(
  ListTargetsByRule,
  Effect.gen(function* () {
    const listTargetsByRule = yield* eventbridge.listTargetsByRule;

    return Effect.fn(function* (rule: Rule) {
      const RuleName = yield* rule.ruleName;
      const EventBusName = yield* rule.eventBusName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.EventBridge.ListTargetsByRule(${rule}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["events:ListTargetsByRule"],
                  Resource: [rule.ruleArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.EventBridge.ListTargetsByRule(${rule.LogicalId})`)(
        function* (request?: ListTargetsByRuleRequest) {
          const ruleName = yield* RuleName;
          const eventBusName = yield* EventBusName;
          return yield* listTargetsByRule({
            ...request,
            Rule: ruleName,
            EventBusName: eventBusName !== "default" ? eventBusName : undefined,
          });
        },
      );
    });
  }),
);
