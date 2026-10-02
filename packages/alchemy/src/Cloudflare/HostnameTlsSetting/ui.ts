import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { HostnameTlsSetting } from "./HostnameTlsSetting.ts";

/**
 * Dashboard UI providers for Cloudflare Hostname TLS Setting resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
const showValue = (value: unknown): string | undefined =>
  value === undefined
    ? undefined
    : Array.isArray(value)
      ? value.join(", ")
      : String(value);

export const HostnameTlsSettingUI = UIProvider.succeed<HostnameTlsSetting>(
  "Cloudflare.HostnameTlsSetting.HostnameTlsSetting",
  {
    displayName: "Hostname TLS Setting",
    icon: "sliders-horizontal",
    color: "#F6821F",
    category: "security",
    summary: (ctx) =>
      ctx.attrs?.hostname === undefined
        ? undefined
        : `${ctx.attrs.hostname} · ${ctx.attrs.settingId ?? ""}`,
    facts: (ctx) => [
      { label: "hostname", value: ctx.attrs?.hostname, copy: true },
      { label: "zone", value: ctx.attrs?.zoneId, mono: true, copy: true },
      { label: "setting", value: ctx.attrs?.settingId, mono: true },
      { label: "value", value: showValue(ctx.attrs?.value), mono: true },
      { label: "status", value: ctx.attrs?.status },
      { label: "updated", value: ctx.attrs?.updatedAt },
    ],
  },
);

export const ui = () => Layer.mergeAll(HostnameTlsSettingUI);
