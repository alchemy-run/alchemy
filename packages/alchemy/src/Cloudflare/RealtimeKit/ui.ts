import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { App } from "./App.ts";
import type { Preset } from "./Preset.ts";
import type { Webhook } from "./Webhook.ts";

/**
 * Dashboard UI providers for Cloudflare RealtimeKit resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const AppUI = UIProvider.succeed<App>("Cloudflare.RealtimeKit.App", {
  displayName: "RealtimeKit App",
  icon: "video",
  color: "#F6821F",
  category: "media",
  summary: (ctx) => ctx.attrs?.name ?? ctx.attrs?.appId,
  facts: (ctx) => [
    { label: "app id", value: ctx.attrs?.appId, mono: true, copy: true },
    { label: "name", value: ctx.attrs?.name },
    { label: "account", value: ctx.attrs?.accountId, mono: true },
    { label: "created", value: ctx.attrs?.createdAt },
  ],
});

export const PresetUI = UIProvider.succeed<Preset>(
  "Cloudflare.RealtimeKit.Preset",
  {
    displayName: "RealtimeKit Preset",
    icon: "sliders-horizontal",
    color: "#F6821F",
    category: "config",
    summary: (ctx) => ctx.attrs?.name ?? ctx.attrs?.presetId,
    facts: (ctx) => [
      {
        label: "preset id",
        value: ctx.attrs?.presetId,
        mono: true,
        copy: true,
      },
      { label: "name", value: ctx.attrs?.name },
      { label: "app id", value: ctx.attrs?.appId, mono: true, copy: true },
      { label: "account", value: ctx.attrs?.accountId, mono: true },
    ],
  },
);

export const WebhookUI = UIProvider.succeed<Webhook>(
  "Cloudflare.RealtimeKit.Webhook",
  {
    displayName: "RealtimeKit Webhook",
    icon: "webhook",
    color: "#F6821F",
    category: "eventing",
    summary: (ctx) => ctx.attrs?.name ?? ctx.attrs?.url,
    facts: (ctx) => [
      {
        label: "webhook id",
        value: ctx.attrs?.webhookId,
        mono: true,
        copy: true,
      },
      { label: "name", value: ctx.attrs?.name },
      {
        label: "url",
        value: ctx.attrs?.url,
        href: ctx.attrs?.url,
        copy: true,
      },
      {
        label: "events",
        value: ctx.attrs?.events?.length
          ? ctx.attrs.events.join(", ")
          : undefined,
        mono: true,
      },
      { label: "enabled", value: ctx.attrs?.enabled },
      { label: "app id", value: ctx.attrs?.appId, mono: true, copy: true },
    ],
  },
);

export const ui = () => Layer.mergeAll(AppUI, PresetUI, WebhookUI);
