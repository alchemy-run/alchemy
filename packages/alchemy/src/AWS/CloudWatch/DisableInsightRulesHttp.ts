import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import {
  sortInsightRuleResources,
  type InsightRuleResource,
} from "./binding-common.ts";
import { DisableInsightRules } from "./DisableInsightRules.ts";

export const DisableInsightRulesHttp = Layer.effect(
  DisableInsightRules,
  Effect.gen(function* () {
    const disableInsightRules = yield* cloudwatch.disableInsightRules;

    return Effect.fn(function* (...rules: InsightRules) {
      const sorted = sortInsightRuleResources(rules);
      const RuleNames = yield* Effect.forEach(sorted, (rule) =>
        rule.ruleName.asEffect(),
      );
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.CloudWatch.DisableInsightRules(${sorted}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["cloudwatch:DisableInsightRules"],
                  Resource: sorted.map((rule) => rule.ruleArn),
                },
              ],
            },
          );
        }
      }

      return Effect.fn(`AWS.CloudWatch.DisableInsightRules(${sorted})`)(
        function* () {
          return yield* disableInsightRules({
            RuleNames: yield* Effect.forEach(RuleNames, (ruleName) => ruleName),
          });
        },
      );
    });
  }),
);

type InsightRules = [InsightRuleResource, ...InsightRuleResource[]];
