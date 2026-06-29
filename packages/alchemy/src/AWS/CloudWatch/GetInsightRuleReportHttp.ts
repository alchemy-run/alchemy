import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Layer from "effect/Layer";
import { isFunction } from "../Lambda/Function.ts";
import type { InsightRule } from "./InsightRule.ts";
import {
  GetInsightRuleReport,
  type GetInsightRuleReportRequest,
} from "./GetInsightRuleReport.ts";

export const GetInsightRuleReportHttp = Layer.effect(
  GetInsightRuleReport,
  Effect.gen(function* () {
    const getInsightRuleReport = yield* cloudwatch.getInsightRuleReport;

    return Effect.fn(function* (rule: InsightRule) {
      const RuleName = yield* rule.ruleName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.CloudWatch.GetInsightRuleReport(${rule}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["cloudwatch:GetInsightRuleReport"],
                  Resource: [rule.ruleArn],
                },
              ],
            },
          );
        }
      }

      return Effect.fn(
        `AWS.CloudWatch.GetInsightRuleReport(${rule.LogicalId})`,
      )(function* (request: GetInsightRuleReportRequest) {
        return yield* getInsightRuleReport({
          ...request,
          RuleName: yield* RuleName,
        });
      });
    });
  }),
);
