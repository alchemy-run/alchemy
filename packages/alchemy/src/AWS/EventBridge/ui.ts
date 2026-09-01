import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { ApiDestination } from "./ApiDestination.ts";
import type { Archive } from "./Archive.ts";
import type { Connection } from "./Connection.ts";
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

export const ApiDestinationUI = UIProvider.succeed<ApiDestination>(
  "AWS.EventBridge.ApiDestination",
  {
    displayName: "EventBridge API Destination",
    icon: "webhook",
    color: "#E7157B",
    category: "eventing",
    summary: (ctx) => ctx.attrs?.apiDestinationName,
    consoleUrl: (ctx) => {
      const region = regionOf(ctx.attrs?.apiDestinationArn);
      return ctx.attrs?.apiDestinationName === undefined || region === undefined
        ? undefined
        : `https://${region}.console.aws.amazon.com/events/home?region=${region}#/apidestinations/${encodeURIComponent(ctx.attrs.apiDestinationName)}`;
    },
    facts: (ctx) => [
      {
        label: "destination",
        value: ctx.attrs?.apiDestinationName,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.apiDestinationArn,
        mono: true,
        copy: true,
      },
      { label: "state", value: ctx.attrs?.apiDestinationState },
      { label: "endpoint", value: ctx.props?.invocationEndpoint, mono: true },
      { label: "method", value: ctx.props?.httpMethod },
      { label: "connection", value: ctx.props?.connectionArn, mono: true },
    ],
  },
);

export const ArchiveUI = UIProvider.succeed<Archive>(
  "AWS.EventBridge.Archive",
  {
    displayName: "EventBridge Archive",
    icon: "archive",
    color: "#E7157B",
    category: "eventing",
    summary: (ctx) => ctx.attrs?.archiveName,
    consoleUrl: (ctx) => {
      const region = regionOf(ctx.attrs?.archiveArn);
      return ctx.attrs?.archiveName === undefined || region === undefined
        ? undefined
        : `https://${region}.console.aws.amazon.com/events/home?region=${region}#/archives/${encodeURIComponent(ctx.attrs.archiveName)}`;
    },
    facts: (ctx) => [
      { label: "archive", value: ctx.attrs?.archiveName, copy: true },
      { label: "arn", value: ctx.attrs?.archiveArn, mono: true, copy: true },
      { label: "event source", value: ctx.attrs?.eventSourceArn, mono: true },
      { label: "retention", value: ctx.props?.retention?.toString() },
    ],
  },
);

export const ConnectionUI = UIProvider.succeed<Connection>(
  "AWS.EventBridge.Connection",
  {
    displayName: "EventBridge Connection",
    icon: "plug",
    color: "#E7157B",
    category: "eventing",
    summary: (ctx) => ctx.attrs?.connectionName,
    consoleUrl: (ctx) => {
      const region = regionOf(ctx.attrs?.connectionArn);
      return ctx.attrs?.connectionName === undefined || region === undefined
        ? undefined
        : `https://${region}.console.aws.amazon.com/events/home?region=${region}#/connections/${encodeURIComponent(ctx.attrs.connectionName)}`;
    },
    facts: (ctx) => [
      { label: "connection", value: ctx.attrs?.connectionName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.connectionArn,
        mono: true,
        copy: true,
      },
      { label: "state", value: ctx.attrs?.connectionState },
      { label: "auth type", value: ctx.props?.authorizationType },
      { label: "secret", value: ctx.attrs?.secretArn, mono: true, copy: true },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(
    EventBusUI,
    RuleUI,
    PermissionUI,
    ApiDestinationUI,
    ArchiveUI,
    ConnectionUI,
  );
