import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Widget } from "./Widget.ts";

/**
 * Dashboard UI providers for Cloudflare Turnstile resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const WidgetUI = UIProvider.succeed<Widget>(
  "Cloudflare.Turnstile.Widget",
  {
    displayName: "Turnstile Widget",
    icon: "shield-check",
    color: "#F6821F",
    category: "security",
    summary: (ctx) => ctx.attrs?.name ?? ctx.props?.name,
    consoleUrl: (ctx) =>
      ctx.attrs?.accountId === undefined
        ? undefined
        : `https://dash.cloudflare.com/${ctx.attrs.accountId}/turnstile`,
    facts: (ctx) => [
      { label: "sitekey", value: ctx.attrs?.sitekey, mono: true, copy: true },
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "mode", value: ctx.attrs?.mode ?? ctx.props?.mode },
      {
        label: "domains",
        value: ctx.attrs?.domains?.length
          ? ctx.attrs.domains.join(", ")
          : undefined,
      },
      { label: "region", value: ctx.attrs?.region },
      { label: "clearance level", value: ctx.attrs?.clearanceLevel },
      {
        label: "bot fight mode",
        value:
          ctx.attrs?.botFightMode === undefined
            ? undefined
            : ctx.attrs.botFightMode
              ? "on"
              : "off",
      },
      {
        label: "account",
        value: ctx.attrs?.accountId,
        mono: true,
        copy: true,
      },
    ],
  },
);

export const ui = () => Layer.mergeAll(WidgetUI);
