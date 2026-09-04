import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { AccessRule } from "./AccessRule.ts";
import type { Lockdown } from "./Lockdown.ts";
import type { UaRule } from "./UaRule.ts";

/**
 * Dashboard UI providers for Cloudflare Firewall resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const AccessRuleUI = UIProvider.succeed<AccessRule>(
  "Cloudflare.Firewall.AccessRule",
  {
    displayName: "Firewall Access Rule",
    icon: "shield",
    color: "#F6821F",
    category: "security",
    summary: (ctx) =>
      ctx.attrs?.configuration?.value === undefined
        ? ctx.props?.configuration?.value
        : `${ctx.attrs.mode} ${ctx.attrs.configuration.value}`,
    facts: (ctx) => [
      { label: "mode", value: ctx.attrs?.mode },
      { label: "target", value: ctx.attrs?.configuration?.target },
      {
        label: "value",
        value: ctx.attrs?.configuration?.value,
        mono: true,
        copy: true,
      },
      { label: "id", value: ctx.attrs?.ruleId, mono: true, copy: true },
      { label: "zone", value: ctx.attrs?.zoneId, mono: true, copy: true },
      { label: "account", value: ctx.attrs?.accountId, mono: true, copy: true },
      { label: "notes", value: ctx.attrs?.notes },
    ],
  },
);

export const LockdownUI = UIProvider.succeed<Lockdown>(
  "Cloudflare.Firewall.Lockdown",
  {
    displayName: "Zone Lockdown",
    icon: "lock",
    color: "#F6821F",
    category: "security",
    summary: (ctx) => ctx.attrs?.urls?.[0] ?? ctx.props?.urls?.[0],
    facts: (ctx) => [
      {
        label: "urls",
        value: ctx.attrs?.urls?.length ? ctx.attrs.urls.join(", ") : undefined,
        mono: true,
      },
      { label: "id", value: ctx.attrs?.lockdownId, mono: true, copy: true },
      { label: "zone", value: ctx.attrs?.zoneId, mono: true, copy: true },
      { label: "paused", value: ctx.attrs?.paused },
      { label: "priority", value: ctx.attrs?.priority },
      { label: "description", value: ctx.attrs?.description },
    ],
  },
);

export const UaRuleUI = UIProvider.succeed<UaRule>(
  "Cloudflare.Firewall.UaRule",
  {
    displayName: "User Agent Rule",
    icon: "user-x",
    color: "#F6821F",
    category: "security",
    summary: (ctx) => ctx.attrs?.userAgent ?? ctx.props?.userAgent,
    facts: (ctx) => [
      { label: "user agent", value: ctx.attrs?.userAgent, mono: true },
      { label: "mode", value: ctx.attrs?.mode },
      { label: "id", value: ctx.attrs?.uaRuleId, mono: true, copy: true },
      { label: "zone", value: ctx.attrs?.zoneId, mono: true, copy: true },
      { label: "paused", value: ctx.attrs?.paused },
      { label: "description", value: ctx.attrs?.description },
    ],
  },
);

export const ui = () => Layer.mergeAll(AccessRuleUI, LockdownUI, UaRuleUI);
