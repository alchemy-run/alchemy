import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Rule } from "./Rule.ts";
import type { Site } from "./Site.ts";

/**
 * Dashboard UI providers for Cloudflare Web Analytics (RUM) resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const SiteUI = UIProvider.succeed<Site>("Cloudflare.Rum.Site", {
  displayName: "Web Analytics Site",
  icon: "chart-line",
  color: "#F6821F",
  category: "observability",
  summary: (ctx) => ctx.attrs?.host ?? ctx.attrs?.siteTag,
  facts: (ctx) => [
    { label: "host", value: ctx.attrs?.host },
    { label: "site tag", value: ctx.attrs?.siteTag, mono: true, copy: true },
    {
      label: "site token",
      value: ctx.attrs?.siteToken,
      mono: true,
      copy: true,
    },
    { label: "zone", value: ctx.attrs?.zoneTag, mono: true },
    { label: "ruleset", value: ctx.attrs?.rulesetId, mono: true, copy: true },
    { label: "auto install", value: ctx.attrs?.autoInstall },
    { label: "created", value: ctx.attrs?.created },
  ],
});

export const RuleUI = UIProvider.succeed<Rule>("Cloudflare.Rum.Rule", {
  displayName: "Web Analytics Rule",
  icon: "filter",
  color: "#F6821F",
  category: "observability",
  summary: (ctx) =>
    ctx.attrs?.host !== undefined || ctx.attrs?.paths?.length
      ? [ctx.attrs?.host, ctx.attrs?.paths?.join(", ")]
          .filter(Boolean)
          .join(" ")
      : ctx.attrs?.id,
  facts: (ctx) => [
    { label: "rule id", value: ctx.attrs?.id, mono: true, copy: true },
    { label: "ruleset", value: ctx.attrs?.rulesetId, mono: true, copy: true },
    { label: "host", value: ctx.attrs?.host },
    { label: "paths", value: ctx.attrs?.paths?.join(", "), mono: true },
    {
      label: "mode",
      value:
        ctx.attrs?.inclusive === undefined
          ? undefined
          : ctx.attrs.inclusive
            ? "include"
            : "exclude",
    },
    { label: "paused", value: ctx.attrs?.isPaused },
  ],
});

export const ui = () => Layer.mergeAll(SiteUI, RuleUI);
