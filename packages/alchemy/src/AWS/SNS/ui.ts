import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { PlatformApplication } from "./PlatformApplication.ts";
import type { Subscription } from "./Subscription.ts";
import type { Topic } from "./Topic.ts";

/**
 * Dashboard UI providers for AWS SNS resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const regionOf = (arn: string | undefined) => arn?.split(":")[3];

export const TopicUI = UIProvider.succeed<Topic>("AWS.SNS.Topic", {
  displayName: "SNS Topic",
  icon: "megaphone",
  color: "#E7157B",
  category: "eventing",
  summary: (ctx) => ctx.attrs?.topicName,
  consoleUrl: (ctx) => {
    const region = regionOf(ctx.attrs?.topicArn);
    return ctx.attrs?.topicArn === undefined || region === undefined
      ? undefined
      : `https://${region}.console.aws.amazon.com/sns/v3/home?region=${region}#/topic/${encodeURIComponent(ctx.attrs.topicArn)}`;
  },
  facts: (ctx) => [
    { label: "topic", value: ctx.attrs?.topicName, copy: true },
    { label: "arn", value: ctx.attrs?.topicArn, mono: true, copy: true },
    { label: "fifo", value: ctx.attrs?.fifo },
  ],
});

export const SubscriptionUI = UIProvider.succeed<Subscription>(
  "AWS.SNS.Subscription",
  {
    displayName: "SNS Subscription",
    icon: "inbox",
    color: "#E7157B",
    category: "eventing",
    summary: (ctx) =>
      ctx.attrs?.endpoint
        ? `${ctx.attrs?.protocol ?? ""}:${ctx.attrs.endpoint}`
        : ctx.attrs?.subscriptionArn,
    consoleUrl: (ctx) => {
      const region = regionOf(ctx.attrs?.subscriptionArn);
      return ctx.attrs?.subscriptionArn === undefined || region === undefined
        ? undefined
        : `https://${region}.console.aws.amazon.com/sns/v3/home?region=${region}#/subscriptions/${encodeURIComponent(ctx.attrs.subscriptionArn)}`;
    },
    facts: (ctx) => [
      {
        label: "arn",
        value: ctx.attrs?.subscriptionArn,
        mono: true,
        copy: true,
      },
      { label: "topic", value: ctx.attrs?.topicArn, mono: true, copy: true },
      { label: "protocol", value: ctx.attrs?.protocol },
      { label: "endpoint", value: ctx.attrs?.endpoint, mono: true },
      { label: "pending", value: ctx.attrs?.pendingConfirmation },
      { label: "owner", value: ctx.attrs?.owner, mono: true },
    ],
  },
);

export const PlatformApplicationUI = UIProvider.succeed<PlatformApplication>(
  "AWS.SNS.PlatformApplication",
  {
    displayName: "SNS Platform Application",
    icon: "bell",
    color: "#E7157B",
    category: "eventing",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.platformApplicationArn,
        mono: true,
        copy: true,
      },
      { label: "platform", value: ctx.attrs?.platform },
      { label: "enabled", value: ctx.attrs?.enabled },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(TopicUI, SubscriptionUI, PlatformApplicationUI);
