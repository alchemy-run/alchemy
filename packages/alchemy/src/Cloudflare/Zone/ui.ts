import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { CustomNameservers } from "./CustomNameservers.ts";
import type { Hold } from "./Hold.ts";
import type { Setting } from "./Setting.ts";
import type { Zone } from "./Zone.ts";

/**
 * Dashboard UI providers for Cloudflare Zone resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const ZoneUI = UIProvider.succeed<Zone>("Cloudflare.Zone.Zone", {
  displayName: "Zone",
  icon: "globe",
  color: "#F6821F",
  category: "dns",
  summary: (ctx) => ctx.attrs?.name,
  link: (ctx) => (ctx.attrs?.name ? `https://${ctx.attrs.name}` : undefined),
  consoleUrl: (ctx) =>
    ctx.attrs?.accountId === undefined || ctx.attrs.name === undefined
      ? undefined
      : `https://dash.cloudflare.com/${ctx.attrs.accountId}/${ctx.attrs.name}`,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name, copy: true },
    { label: "zone id", value: ctx.attrs?.zoneId, mono: true, copy: true },
    { label: "account", value: ctx.attrs?.accountId, mono: true, copy: true },
    { label: "type", value: ctx.attrs?.type },
    { label: "status", value: ctx.attrs?.status },
    { label: "paused", value: ctx.attrs?.paused },
    {
      label: "name servers",
      value: ctx.attrs?.nameServers?.length
        ? ctx.attrs.nameServers.join(", ")
        : undefined,
      mono: true,
    },
  ],
});

export const SettingUI = UIProvider.succeed<Setting>(
  "Cloudflare.Zone.Setting",
  {
    displayName: "Zone Setting",
    icon: "settings-2",
    color: "#F6821F",
    category: "config",
    summary: (ctx) => ctx.attrs?.settingId ?? ctx.props?.settingId,
    facts: (ctx) => [
      { label: "setting", value: ctx.attrs?.settingId, mono: true },
      {
        label: "value",
        value:
          ctx.attrs?.value === undefined
            ? undefined
            : typeof ctx.attrs.value === "object"
              ? JSON.stringify(ctx.attrs.value)
              : String(ctx.attrs.value as string | number | boolean),
        mono: true,
      },
      { label: "zone id", value: ctx.attrs?.zoneId, mono: true, copy: true },
      { label: "editable", value: ctx.attrs?.editable },
      { label: "modified", value: ctx.attrs?.modifiedOn },
    ],
  },
);

export const HoldUI = UIProvider.succeed<Hold>("Cloudflare.Zone.Hold", {
  displayName: "Zone Hold",
  icon: "lock",
  color: "#F6821F",
  category: "security",
  summary: (ctx) => ctx.attrs?.zoneId ?? ctx.props?.zoneId,
  facts: (ctx) => [
    { label: "zone id", value: ctx.attrs?.zoneId, mono: true, copy: true },
    { label: "hold", value: ctx.attrs?.hold },
    { label: "include subdomains", value: ctx.attrs?.includeSubdomains },
    { label: "hold after", value: ctx.attrs?.holdAfter },
  ],
});

export const CustomNameserversUI = UIProvider.succeed<CustomNameservers>(
  "Cloudflare.Zone.CustomNameservers",
  {
    displayName: "Custom Nameservers",
    icon: "server",
    color: "#F6821F",
    category: "dns",
    summary: (ctx) =>
      ctx.attrs?.enabled === undefined
        ? ctx.props?.zoneId
        : ctx.attrs.enabled
          ? `enabled (set ${ctx.attrs.nsSet ?? 1})`
          : "disabled",
    facts: (ctx) => [
      { label: "zone id", value: ctx.attrs?.zoneId, mono: true, copy: true },
      { label: "enabled", value: ctx.attrs?.enabled },
      { label: "ns set", value: ctx.attrs?.nsSet },
      { label: "initial enabled", value: ctx.attrs?.initialEnabled },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(ZoneUI, SettingUI, HoldUI, CustomNameserversUI);
