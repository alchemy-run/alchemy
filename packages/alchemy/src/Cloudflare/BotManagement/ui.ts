import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { BotManagement } from "./BotManagement.ts";

/**
 * Dashboard UI providers for Cloudflare Bot Management resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const BotManagementUI = UIProvider.succeed<BotManagement>(
  "Cloudflare.BotManagement.BotManagement",
  {
    displayName: "Bot Management",
    icon: "bot",
    color: "#F6821F",
    category: "security",
    summary: (ctx) => ctx.attrs?.zoneId ?? ctx.props?.zoneId,
    consoleUrl: (ctx) =>
      ctx.attrs?.zoneId === undefined
        ? undefined
        : `https://dash.cloudflare.com/?to=/:account/${ctx.attrs.zoneId}/security/bots`,
    facts: (ctx) => [
      { label: "zone", value: ctx.attrs?.zoneId, mono: true, copy: true },
      { label: "fight mode", value: ctx.attrs?.fightMode },
      { label: "ai bots protection", value: ctx.attrs?.aiBotsProtection },
      { label: "crawler protection", value: ctx.attrs?.crawlerProtection },
      { label: "enable js", value: ctx.attrs?.enableJs },
      { label: "auto-update model", value: ctx.attrs?.autoUpdateModel },
      { label: "latest model", value: ctx.attrs?.usingLatestModel },
    ],
  },
);

export const ui = () => Layer.mergeAll(BotManagementUI);
