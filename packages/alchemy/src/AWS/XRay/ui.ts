import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Group } from "./Group.ts";
import type { ResourcePolicy } from "./ResourcePolicy.ts";
import type { SamplingRule } from "./SamplingRule.ts";

/**
 * Dashboard UI providers for AWS XRay resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

export const GroupUI = UIProvider.succeed<Group>("AWS.XRay.Group", {
  displayName: "X-Ray Group",
  icon: "search",
  color: "#E7157B",
  category: "observability",
  summary: (ctx) => ctx.attrs?.groupName,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.groupName, copy: true },
    { label: "arn", value: ctx.attrs?.groupArn, mono: true, copy: true },
    { label: "filter", value: ctx.props?.filterExpression, mono: true },
    { label: "insights", value: ctx.props?.insightsEnabled },
  ],
});

export const ResourcePolicyUI = UIProvider.succeed<ResourcePolicy>(
  "AWS.XRay.ResourcePolicy",
  {
    displayName: "X-Ray Resource Policy",
    icon: "lock",
    color: "#E7157B",
    category: "security",
    summary: (ctx) => ctx.attrs?.policyName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.policyName, copy: true },
      {
        label: "revision",
        value: ctx.attrs?.policyRevisionId,
        mono: true,
      },
    ],
  },
);

export const SamplingRuleUI = UIProvider.succeed<SamplingRule>(
  "AWS.XRay.SamplingRule",
  {
    displayName: "X-Ray Sampling Rule",
    icon: "filter",
    color: "#E7157B",
    category: "observability",
    summary: (ctx) => ctx.attrs?.ruleName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.ruleName, copy: true },
      { label: "arn", value: ctx.attrs?.ruleArn, mono: true, copy: true },
      { label: "priority", value: ctx.props?.priority },
      { label: "fixed rate", value: ctx.props?.fixedRate },
      { label: "reservoir size", value: ctx.props?.reservoirSize },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(GroupUI, ResourcePolicyUI, SamplingRuleUI);
