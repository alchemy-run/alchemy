import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Protection } from "./Protection.ts";
import type { ProtectionGroup } from "./ProtectionGroup.ts";
import type { Subscription } from "./Subscription.ts";

/**
 * Dashboard UI providers for AWS Shield resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const COLOR = "#DD344C";

export const ProtectionUI = UIProvider.succeed<Protection>(
  "AWS.Shield.Protection",
  {
    displayName: "Shield Protection",
    icon: "shield",
    color: COLOR,
    category: "security",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "id", value: ctx.attrs?.protectionId, mono: true },
      {
        label: "arn",
        value: ctx.attrs?.protectionArn,
        mono: true,
        copy: true,
      },
      { label: "resource", value: ctx.attrs?.resourceArn, mono: true },
      {
        label: "layer 7 mitigation",
        value: ctx.attrs?.applicationLayerAutomaticResponse,
      },
    ],
  },
);

export const ProtectionGroupUI = UIProvider.succeed<ProtectionGroup>(
  "AWS.Shield.ProtectionGroup",
  {
    displayName: "Shield Protection Group",
    icon: "layers",
    color: COLOR,
    category: "security",
    summary: (ctx) => ctx.attrs?.protectionGroupId,
    facts: (ctx) => [
      { label: "id", value: ctx.attrs?.protectionGroupId, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.protectionGroupArn,
        mono: true,
        copy: true,
      },
      { label: "aggregation", value: ctx.attrs?.aggregation },
      { label: "pattern", value: ctx.attrs?.pattern },
      { label: "resource type", value: ctx.attrs?.resourceType },
    ],
  },
);

export const SubscriptionUI = UIProvider.succeed<Subscription>(
  "AWS.Shield.Subscription",
  {
    displayName: "Shield Subscription",
    icon: "credit-card",
    color: COLOR,
    category: "security",
    summary: (ctx) => ctx.attrs?.subscriptionArn?.split("/").pop(),
    facts: (ctx) => [
      {
        label: "arn",
        value: ctx.attrs?.subscriptionArn,
        mono: true,
        copy: true,
      },
      { label: "auto renew", value: ctx.attrs?.autoRenew },
      { label: "start", value: ctx.attrs?.startTime },
      { label: "end", value: ctx.attrs?.endTime },
      {
        label: "proactive engagement",
        value: ctx.attrs?.proactiveEngagementStatus,
      },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(ProtectionUI, ProtectionGroupUI, SubscriptionUI);
