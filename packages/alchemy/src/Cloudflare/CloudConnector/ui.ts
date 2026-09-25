import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Rules } from "./Rules.ts";

/**
 * Dashboard UI providers for Cloudflare CloudConnector resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const RulesUI = UIProvider.succeed<Rules>(
  "Cloudflare.CloudConnector.Rules",
  {
    displayName: "Cloud Connector Rules",
    icon: "cable",
    color: "#F6821F",
    category: "network",
    summary: (ctx) =>
      ctx.attrs?.rules?.length !== undefined
        ? `${ctx.attrs.rules.length} rule${ctx.attrs.rules.length === 1 ? "" : "s"}`
        : ctx.props?.zoneId,
    facts: (ctx) => [
      { label: "zone id", value: ctx.attrs?.zoneId, mono: true, copy: true },
      { label: "rules", value: ctx.attrs?.rules?.length },
      {
        label: "providers",
        value: ctx.attrs?.rules?.length
          ? [...new Set(ctx.attrs.rules.map((r) => r?.provider))].join(", ")
          : undefined,
        mono: true,
      },
      {
        label: "hosts",
        value: ctx.attrs?.rules?.length
          ? ctx.attrs.rules.map((r) => r?.host).join(", ")
          : undefined,
        mono: true,
      },
    ],
  },
);

export const ui = () => Layer.mergeAll(RulesUI);
