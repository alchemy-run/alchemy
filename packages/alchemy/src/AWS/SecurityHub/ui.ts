import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { ActionTarget } from "./ActionTarget.ts";
import type { AutomationRule } from "./AutomationRule.ts";
import type { FindingAggregator } from "./FindingAggregator.ts";
import type { Hub } from "./Hub.ts";
import type { Insight } from "./Insight.ts";

/**
 * Dashboard UI providers for AWS SecurityHub resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** Security Hub brand color (AWS Security, Identity & Compliance red). */
const SECURITYHUB_COLOR = "#DD344C";

export const HubUI = UIProvider.succeed<Hub>("AWS.SecurityHub.Hub", {
  displayName: "Security Hub",
  icon: "shield-check",
  color: SECURITYHUB_COLOR,
  category: "security",
  summary: (ctx) => ctx.attrs?.hubArn,
  facts: (ctx) => [
    { label: "arn", value: ctx.attrs?.hubArn, mono: true, copy: true },
    { label: "subscribed at", value: ctx.attrs?.subscribedAt },
    { label: "auto-enable controls", value: ctx.attrs?.autoEnableControls },
    {
      label: "control finding generator",
      value: ctx.attrs?.controlFindingGenerator,
    },
  ],
});

export const ActionTargetUI = UIProvider.succeed<ActionTarget>(
  "AWS.SecurityHub.ActionTarget",
  {
    displayName: "Security Hub Action Target",
    icon: "flag",
    color: SECURITYHUB_COLOR,
    category: "security",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.actionTargetArn,
        mono: true,
        copy: true,
      },
      { label: "id", value: ctx.attrs?.id, mono: true },
      { label: "description", value: ctx.attrs?.description },
    ],
  },
);

export const AutomationRuleUI = UIProvider.succeed<AutomationRule>(
  "AWS.SecurityHub.AutomationRule",
  {
    displayName: "Security Hub Automation Rule",
    icon: "filter",
    color: SECURITYHUB_COLOR,
    category: "security",
    summary: (ctx) => ctx.attrs?.ruleName,
    facts: (ctx) => [
      { label: "rule", value: ctx.attrs?.ruleName, copy: true },
      { label: "arn", value: ctx.attrs?.ruleArn, mono: true, copy: true },
      { label: "order", value: ctx.attrs?.ruleOrder },
      { label: "status", value: ctx.attrs?.ruleStatus },
      { label: "terminal", value: ctx.attrs?.isTerminal },
    ],
  },
);

export const FindingAggregatorUI = UIProvider.succeed<FindingAggregator>(
  "AWS.SecurityHub.FindingAggregator",
  {
    displayName: "Security Hub Finding Aggregator",
    icon: "merge",
    color: SECURITYHUB_COLOR,
    category: "security",
    summary: (ctx) => ctx.attrs?.findingAggregatorArn,
    facts: (ctx) => [
      {
        label: "arn",
        value: ctx.attrs?.findingAggregatorArn,
        mono: true,
        copy: true,
      },
      { label: "home region", value: ctx.attrs?.findingAggregationRegion },
      { label: "linking mode", value: ctx.attrs?.regionLinkingMode },
      { label: "regions", value: ctx.attrs?.regions?.join(", ") },
    ],
  },
);

export const InsightUI = UIProvider.succeed<Insight>(
  "AWS.SecurityHub.Insight",
  {
    displayName: "Security Hub Insight",
    icon: "search",
    color: SECURITYHUB_COLOR,
    category: "security",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "insight", value: ctx.attrs?.name, copy: true },
      { label: "arn", value: ctx.attrs?.insightArn, mono: true, copy: true },
      { label: "group by", value: ctx.attrs?.groupByAttribute },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(
    HubUI,
    ActionTargetUI,
    AutomationRuleUI,
    FindingAggregatorUI,
    InsightUI,
  );
