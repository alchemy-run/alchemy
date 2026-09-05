import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Rule } from "./Rule.ts";

/**
 * Dashboard UI providers for AWS Rbin (Recycle Bin) resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

export const RuleUI = UIProvider.succeed<Rule>("AWS.Rbin.Rule", {
  displayName: "Recycle Bin Rule",
  icon: "trash-2",
  color: "#7AA116",
  category: "storage",
  summary: (ctx) => ctx.attrs?.resourceType,
  facts: (ctx) => [
    { label: "id", value: ctx.attrs?.identifier, mono: true, copy: true },
    { label: "arn", value: ctx.attrs?.ruleArn, mono: true, copy: true },
    { label: "resource type", value: ctx.attrs?.resourceType },
    { label: "status", value: ctx.attrs?.status },
    { label: "lock", value: ctx.attrs?.lockState },
  ],
});

export const ui = () => Layer.mergeAll(RuleUI);
