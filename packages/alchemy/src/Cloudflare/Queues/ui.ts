import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Consumer } from "./Consumer.ts";
import type { Queue } from "./Queue.ts";
import type { Subscription } from "./Subscription.ts";

/**
 * Dashboard UI providers for Cloudflare Queues resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const QueueUI = UIProvider.succeed<Queue>("Cloudflare.Queues.Queue", {
  displayName: "Queue",
  icon: "list-ordered",
  color: "#F6821F",
  category: "queue",
  summary: (ctx) => ctx.attrs?.queueName,
  consoleUrl: (ctx) =>
    ctx.attrs?.accountId === undefined || ctx.attrs.queueId === undefined
      ? undefined
      : `https://dash.cloudflare.com/${ctx.attrs.accountId}/workers/queues/queue/${ctx.attrs.queueId}`,
  facts: (ctx) => [
    { label: "queue", value: ctx.attrs?.queueName, copy: true },
    { label: "queue id", value: ctx.attrs?.queueId, mono: true, copy: true },
    { label: "account", value: ctx.attrs?.accountId, mono: true, copy: true },
  ],
});

export const ConsumerUI = UIProvider.succeed<Consumer>(
  "Cloudflare.Queues.Consumer",
  {
    displayName: "Queue Consumer",
    icon: "inbox",
    color: "#F6821F",
    category: "queue",
    summary: (ctx) => ctx.attrs?.scriptName ?? ctx.props?.scriptName,
    facts: (ctx) => [
      { label: "script", value: ctx.attrs?.scriptName, mono: true },
      {
        label: "consumer id",
        value: ctx.attrs?.consumerId,
        mono: true,
        copy: true,
      },
      { label: "queue id", value: ctx.attrs?.queueId, mono: true, copy: true },
      { label: "dead letter queue", value: ctx.attrs?.deadLetterQueue },
      { label: "batch size", value: ctx.attrs?.settings?.batchSize },
      { label: "max retries", value: ctx.attrs?.settings?.maxRetries },
      {
        label: "account",
        value: ctx.attrs?.accountId,
        mono: true,
        copy: true,
      },
    ],
  },
);

export const SubscriptionUI = UIProvider.succeed<Subscription>(
  "Cloudflare.Queues.Subscription",
  {
    displayName: "Queue Subscription",
    icon: "rss",
    color: "#F6821F",
    category: "eventing",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      {
        label: "subscription id",
        value: ctx.attrs?.subscriptionId,
        mono: true,
        copy: true,
      },
      { label: "source", value: ctx.attrs?.source?.type },
      {
        label: "events",
        value: ctx.attrs?.events?.length
          ? ctx.attrs.events.join(", ")
          : undefined,
        mono: true,
      },
      { label: "queue id", value: ctx.attrs?.queueId, mono: true, copy: true },
      { label: "enabled", value: ctx.attrs?.enabled },
      {
        label: "account",
        value: ctx.attrs?.accountId,
        mono: true,
        copy: true,
      },
    ],
  },
);

export const ui = () => Layer.mergeAll(QueueUI, ConsumerUI, SubscriptionUI);
