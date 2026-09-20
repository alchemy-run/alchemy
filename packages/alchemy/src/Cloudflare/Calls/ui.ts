import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { App } from "./App.ts";
import type { TurnKey } from "./TurnKey.ts";

/**
 * Dashboard UI providers for Cloudflare Calls (Realtime SFU) resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const AppUI = UIProvider.succeed<App>("Cloudflare.Calls.App", {
  displayName: "Calls App",
  icon: "video",
  color: "#F6821F",
  category: "media",
  summary: (ctx) => ctx.attrs?.name ?? ctx.attrs?.appId,
  consoleUrl: (ctx) =>
    ctx.attrs?.accountId === undefined
      ? undefined
      : `https://dash.cloudflare.com/${ctx.attrs.accountId}/calls`,
  facts: (ctx) => [
    { label: "app id", value: ctx.attrs?.appId, mono: true, copy: true },
    { label: "name", value: ctx.attrs?.name },
    { label: "account", value: ctx.attrs?.accountId, mono: true },
    { label: "created", value: ctx.attrs?.created },
    { label: "modified", value: ctx.attrs?.modified },
  ],
});

export const TurnKeyUI = UIProvider.succeed<TurnKey>(
  "Cloudflare.Calls.TurnKey",
  {
    displayName: "Calls TURN Key",
    icon: "key-round",
    color: "#F6821F",
    category: "security",
    summary: (ctx) => ctx.attrs?.name ?? ctx.attrs?.keyId,
    consoleUrl: (ctx) =>
      ctx.attrs?.accountId === undefined
        ? undefined
        : `https://dash.cloudflare.com/${ctx.attrs.accountId}/calls`,
    facts: (ctx) => [
      { label: "key id", value: ctx.attrs?.keyId, mono: true, copy: true },
      { label: "name", value: ctx.attrs?.name },
      { label: "account", value: ctx.attrs?.accountId, mono: true },
      { label: "created", value: ctx.attrs?.created },
      { label: "modified", value: ctx.attrs?.modified },
    ],
  },
);

export const ui = () => Layer.mergeAll(AppUI, TurnKeyUI);
