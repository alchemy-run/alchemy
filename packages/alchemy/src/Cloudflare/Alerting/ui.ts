import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { NotificationPolicy } from "./NotificationPolicy.ts";
import type { Silence } from "./Silence.ts";
import type { NotificationWebhook } from "./Webhook.ts";

/**
 * Dashboard UI providers for Cloudflare Alerting resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const NotificationPolicyUI = UIProvider.succeed<NotificationPolicy>(
  "Cloudflare.Alerting.NotificationPolicy",
  {
    displayName: "Notification Policy",
    icon: "bell",
    color: "#F6821F",
    category: "observability",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      {
        label: "policy id",
        value: ctx.attrs?.policyId,
        mono: true,
        copy: true,
      },
      { label: "alert type", value: ctx.attrs?.alertType, mono: true },
      { label: "enabled", value: ctx.attrs?.enabled },
      { label: "created", value: ctx.attrs?.created },
      { label: "modified", value: ctx.attrs?.modified },
    ],
  },
);

export const SilenceUI = UIProvider.succeed<Silence>(
  "Cloudflare.Alerting.Silence",
  {
    displayName: "Alert Silence",
    icon: "bell-off",
    color: "#F6821F",
    category: "observability",
    summary: (ctx) => ctx.attrs?.silenceId,
    facts: (ctx) => [
      {
        label: "silence id",
        value: ctx.attrs?.silenceId,
        mono: true,
        copy: true,
      },
      { label: "policy", value: ctx.attrs?.policyId, mono: true, copy: true },
      { label: "start", value: ctx.attrs?.startTime },
      { label: "end", value: ctx.attrs?.endTime },
    ],
  },
);

export const NotificationWebhookUI = UIProvider.succeed<NotificationWebhook>(
  "Cloudflare.Alerting.Webhook",
  {
    displayName: "Notification Webhook",
    icon: "webhook",
    color: "#F6821F",
    category: "eventing",
    summary: (ctx) => ctx.attrs?.name,
    link: (ctx) => ctx.attrs?.url,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      {
        label: "url",
        value: ctx.attrs?.url,
        href: ctx.attrs?.url,
        copy: true,
      },
      {
        label: "webhook id",
        value: ctx.attrs?.webhookId,
        mono: true,
        copy: true,
      },
      { label: "type", value: ctx.attrs?.type },
      { label: "created", value: ctx.attrs?.createdAt },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(NotificationPolicyUI, SilenceUI, NotificationWebhookUI);
