import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Rule } from "./Rule.ts";

/**
 * Dashboard UI providers for Cloudflare TokenValidation resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const RuleUI = UIProvider.succeed<Rule>(
  "Cloudflare.TokenValidation.Rule",
  {
    displayName: "Token Validation Rule",
    icon: "shield-check",
    color: "#F6821F",
    category: "security",
    summary: (ctx) => ctx.attrs?.title ?? ctx.props?.title,
    facts: (ctx) => [
      { label: "rule id", value: ctx.attrs?.ruleId, mono: true, copy: true },
      { label: "title", value: ctx.attrs?.title, copy: true },
      { label: "action", value: ctx.attrs?.action ?? ctx.props?.action },
      {
        label: "enabled",
        value:
          ctx.attrs?.enabled === undefined
            ? undefined
            : ctx.attrs.enabled
              ? "yes"
              : "no",
      },
      {
        label: "expression",
        value: ctx.attrs?.expression ?? ctx.props?.expression,
        mono: true,
        copy: true,
      },
      { label: "zone", value: ctx.attrs?.zoneId, mono: true, copy: true },
      { label: "last updated", value: ctx.attrs?.lastUpdated },
    ],
  },
);

export const ui = () => Layer.mergeAll(RuleUI);
