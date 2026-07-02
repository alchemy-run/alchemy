import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Policy } from "./Policy.ts";
import type { Settings } from "./Settings.ts";

/**
 * Dashboard UI providers for Cloudflare Page Shield resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const PolicyUI = UIProvider.succeed<Policy>(
  "Cloudflare.PageShield.Policy",
  {
    displayName: "Page Shield Policy",
    icon: "shield-alert",
    color: "#F6821F",
    category: "security",
    summary: (ctx) => ctx.attrs?.description ?? ctx.attrs?.expression,
    facts: (ctx) => [
      { label: "action", value: ctx.attrs?.action },
      { label: "expression", value: ctx.attrs?.expression, mono: true },
      { label: "value", value: ctx.attrs?.value, mono: true },
      { label: "enabled", value: ctx.attrs?.enabled },
      { label: "id", value: ctx.attrs?.policyId, mono: true, copy: true },
      { label: "zone", value: ctx.attrs?.zoneId, mono: true, copy: true },
      { label: "description", value: ctx.attrs?.description },
    ],
  },
);

export const SettingsUI = UIProvider.succeed<Settings>(
  "Cloudflare.PageShield.Settings",
  {
    displayName: "Page Shield Settings",
    icon: "shield",
    color: "#F6821F",
    category: "security",
    summary: (ctx) =>
      ctx.attrs?.enabled === undefined
        ? (ctx.attrs?.zoneId ?? ctx.props?.zoneId)
        : ctx.attrs.enabled
          ? "enabled"
          : "disabled",
    facts: (ctx) => [
      { label: "zone", value: ctx.attrs?.zoneId, mono: true, copy: true },
      { label: "enabled", value: ctx.attrs?.enabled },
      {
        label: "cf reporting endpoint",
        value: ctx.attrs?.useCloudflareReportingEndpoint,
      },
      {
        label: "connection url path",
        value: ctx.attrs?.useConnectionUrlPath,
      },
      { label: "updated", value: ctx.attrs?.updatedAt },
    ],
  },
);

export const ui = () => Layer.mergeAll(PolicyUI, SettingsUI);
