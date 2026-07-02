import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { EventBus } from "./EventBus.ts";
import type { Permission } from "./Permission.ts";
import type { Rule } from "./Rule.ts";

/**
 * Dashboard UI providers for AWS EventBridge resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const regionOf = (arn: string | undefined) => arn?.split(":")[3];

export const EventBusUI = UIProvider.succeed<EventBus>(
  "AWS.EventBridge.EventBus",
  {
    displayName: "EventBridge Bus",
    icon: "network",
    color: "#E7157B",
    category: "eventing",
    summary: (ctx) => ctx.attrs?.eventBusName,
    consoleUrl: (ctx) => {
      const region = regionOf(ctx.attrs?.eventBusArn);
      return ctx.attrs?.eventBusName === undefined || region === undefined
        ? undefined
        : `https://${region}.console.aws.amazon.com/events/home?region=${region}#/eventbus/${encodeURIComponent(ctx.attrs.eventBusName)}`;
    },
    facts: (ctx) => [
      { label: "event bus", value: ctx.attrs?.eventBusName, copy: true },
      { label: "arn", value: ctx.attrs?.eventBusArn, mono: true, copy: true },
      { label: "description", value: ctx.attrs?.description },
    ],
  },
);

export const RuleUI = UIProvider.succeed<Rule>("AWS.EventBridge.Rule", {
  displayName: "EventBridge Rule",
  icon: "route",
  color: "#E7157B",
  category: "eventing",
  summary: (ctx) => ctx.attrs?.ruleName,
  consoleUrl: (ctx) => {
    const region = regionOf(ctx.attrs?.ruleArn);
    return ctx.attrs?.ruleName === undefined ||
      ctx.attrs?.eventBusName === undefined ||
      region === undefined
      ? undefined
      : `https://${region}.console.aws.amazon.com/events/home?region=${region}#/eventbus/${encodeURIComponent(ctx.attrs.eventBusName)}/rules/${encodeURIComponent(ctx.attrs.ruleName)}`;
  },
  facts: (ctx) => [
    { label: "rule", value: ctx.attrs?.ruleName, copy: true },
    { label: "arn", value: ctx.attrs?.ruleArn, mono: true, copy: true },
    { label: "event bus", value: ctx.attrs?.eventBusName },
    { label: "schedule", value: ctx.props?.scheduleExpression, mono: true },
    { label: "state", value: ctx.props?.state },
    {
      label: "targets",
      value: Array.isArray(ctx.props?.targets)
        ? ctx.props.targets.length
        : undefined,
    },
  ],
});

export const PermissionUI = UIProvider.succeed<Permission>(
  "AWS.EventBridge.Permission",
  {
    displayName: "EventBridge Permission",
    icon: "shield-check",
    color: "#E7157B",
    category: "eventing",
    summary: (ctx) => ctx.attrs?.statementId,
    facts: (ctx) => [
      {
        label: "statement id",
        value: ctx.attrs?.statementId,
        mono: true,
        copy: true,
      },
      { label: "event bus", value: ctx.attrs?.eventBusName },
      { label: "principal", value: ctx.props?.principal, mono: true },
      { label: "action", value: ctx.props?.action, mono: true },
    ],
  },
);

export const ui = () => Layer.mergeAll(EventBusUI, RuleUI, PermissionUI);
