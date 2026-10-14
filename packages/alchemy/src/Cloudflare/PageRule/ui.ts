import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { PageRule } from "./PageRule.ts";

/**
 * Dashboard UI providers for Cloudflare PageRule resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const PageRuleUI = UIProvider.succeed<PageRule>(
  "Cloudflare.PageRule.PageRule",
  {
    displayName: "Page Rule",
    icon: "route",
    color: "#F6821F",
    category: "cdn",
    summary: (ctx) => ctx.attrs?.target ?? ctx.props?.target,
    facts: (ctx) => [
      { label: "target", value: ctx.attrs?.target, mono: true, copy: true },
      {
        label: "rule id",
        value: ctx.attrs?.pageRuleId,
        mono: true,
        copy: true,
      },
      { label: "zone id", value: ctx.attrs?.zoneId, mono: true, copy: true },
      { label: "status", value: ctx.attrs?.status },
      { label: "priority", value: ctx.attrs?.priority },
      {
        label: "actions",
        value: ctx.attrs?.actions?.length
          ? ctx.attrs.actions.map((a) => a?.id).join(", ")
          : undefined,
        mono: true,
      },
      { label: "modified", value: ctx.attrs?.modifiedOn },
    ],
  },
);

export const ui = () => Layer.mergeAll(PageRuleUI);
