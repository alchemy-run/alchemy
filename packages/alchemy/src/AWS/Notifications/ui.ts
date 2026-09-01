import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { ChannelAssociation } from "./ChannelAssociation.ts";
import type { EventRule } from "./EventRule.ts";
import type { NotificationConfiguration } from "./NotificationConfiguration.ts";
import type { NotificationHub } from "./NotificationHub.ts";

/**
 * Dashboard UI providers for AWS Notifications resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS Management & Governance (User Notifications) brand pink. */
const COLOR = "#E7157B";

export const NotificationConfigurationUI =
  UIProvider.succeed<NotificationConfiguration>(
    "AWS.Notifications.NotificationConfiguration",
    {
      displayName: "Notification Configuration",
      icon: "bell",
      color: COLOR,
      category: "eventing",
      summary: (ctx) => ctx.attrs?.name,
      facts: (ctx) => [
        { label: "name", value: ctx.attrs?.name, copy: true },
        {
          label: "arn",
          value: ctx.attrs?.notificationConfigurationArn,
          mono: true,
          copy: true,
        },
        { label: "status", value: ctx.attrs?.status },
        { label: "description", value: ctx.attrs?.description },
      ],
    },
  );

export const EventRuleUI = UIProvider.succeed<EventRule>(
  "AWS.Notifications.EventRule",
  {
    displayName: "Notifications Event Rule",
    icon: "webhook",
    color: COLOR,
    category: "eventing",
    summary: (ctx) =>
      ctx.attrs?.source === undefined || ctx.attrs?.eventType === undefined
        ? undefined
        : `${ctx.attrs.source}: ${ctx.attrs.eventType}`,
    facts: (ctx) => [
      {
        label: "arn",
        value: ctx.attrs?.eventRuleArn,
        mono: true,
        copy: true,
      },
      {
        label: "configuration",
        value: ctx.attrs?.notificationConfigurationArn,
        mono: true,
        copy: true,
      },
      { label: "source", value: ctx.attrs?.source, mono: true },
      { label: "event type", value: ctx.attrs?.eventType },
      { label: "regions", value: ctx.attrs?.regions?.join(", "), mono: true },
    ],
  },
);

export const NotificationHubUI = UIProvider.succeed<NotificationHub>(
  "AWS.Notifications.NotificationHub",
  {
    displayName: "Notification Hub",
    icon: "waypoints",
    color: COLOR,
    category: "eventing",
    summary: (ctx) => ctx.attrs?.notificationHubRegion,
    facts: (ctx) => [
      { label: "region", value: ctx.attrs?.notificationHubRegion, copy: true },
      { label: "status", value: ctx.attrs?.status },
    ],
  },
);

export const ChannelAssociationUI = UIProvider.succeed<ChannelAssociation>(
  "AWS.Notifications.ChannelAssociation",
  {
    displayName: "Notifications Channel Association",
    icon: "link",
    color: COLOR,
    category: "eventing",
    summary: (ctx) => ctx.attrs?.channelArn,
    facts: (ctx) => [
      {
        label: "channel",
        value: ctx.attrs?.channelArn,
        mono: true,
        copy: true,
      },
      {
        label: "configuration",
        value: ctx.attrs?.notificationConfigurationArn,
        mono: true,
        copy: true,
      },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(
    NotificationConfigurationUI,
    EventRuleUI,
    NotificationHubUI,
    ChannelAssociationUI,
  );
