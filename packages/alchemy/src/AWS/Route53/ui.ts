import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { HealthCheck } from "./HealthCheck.ts";
import type { HostedZone } from "./HostedZone.ts";
import type { QueryLoggingConfig } from "./QueryLoggingConfig.ts";
import type { Record } from "./Record.ts";
import type { VpcAssociationAuthorization } from "./VpcAssociationAuthorization.ts";
import type { ZoneVpcAssociation } from "./ZoneVpcAssociation.ts";

/**
 * Dashboard UI providers for AWS Route 53 resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS Networking & Content Delivery brand purple. */
const COLOR = "#8C4FFF";

export const HostedZoneUI = UIProvider.succeed<HostedZone>(
  "AWS.Route53.HostedZone",
  {
    displayName: "Route 53 Hosted Zone",
    icon: "globe",
    color: COLOR,
    category: "dns",
    summary: (ctx) => ctx.attrs?.name,
    consoleUrl: (ctx) =>
      ctx.attrs?.id === undefined
        ? undefined
        : `https://console.aws.amazon.com/route53/v2/hostedzones#ListRecordSets/${ctx.attrs.id}`,
    facts: (ctx) => [
      { label: "zone", value: ctx.attrs?.name, copy: true },
      { label: "zone id", value: ctx.attrs?.id, mono: true, copy: true },
      {
        label: "name servers",
        value: ctx.attrs?.nameServers?.join(", "),
        mono: true,
        copy: true,
      },
      { label: "comment", value: ctx.attrs?.comment },
    ],
  },
);

export const RecordUI = UIProvider.succeed<Record>("AWS.Route53.Record", {
  displayName: "Route 53 Record",
  icon: "list",
  color: COLOR,
  category: "dns",
  summary: (ctx) =>
    ctx.attrs?.name === undefined
      ? undefined
      : `${ctx.attrs.name} ${ctx.attrs.type ?? ""}`.trim(),
  consoleUrl: (ctx) =>
    ctx.attrs?.hostedZoneId === undefined
      ? undefined
      : `https://console.aws.amazon.com/route53/v2/hostedzones#ListRecordSets/${ctx.attrs.hostedZoneId}`,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name, mono: true, copy: true },
    { label: "type", value: ctx.attrs?.type, mono: true },
    { label: "ttl", value: ctx.attrs?.ttl },
    {
      label: "values",
      value: ctx.attrs?.records?.join(", "),
      mono: true,
      copy: true,
    },
    {
      label: "alias target",
      value: ctx.attrs?.aliasTarget?.dnsName,
      mono: true,
    },
    {
      label: "zone id",
      value: ctx.attrs?.hostedZoneId,
      mono: true,
      copy: true,
    },
    { label: "set identifier", value: ctx.attrs?.setIdentifier, mono: true },
    {
      label: "routing",
      value:
        ctx.attrs?.weight !== undefined
          ? `weighted (${ctx.attrs.weight})`
          : ctx.attrs?.failover !== undefined
            ? `failover (${ctx.attrs.failover})`
            : ctx.attrs?.region !== undefined
              ? `latency (${ctx.attrs.region})`
              : ctx.attrs?.multiValueAnswer
                ? "multivalue"
                : ctx.attrs?.geoLocation !== undefined
                  ? "geolocation"
                  : ctx.attrs?.geoProximityLocation !== undefined
                    ? "geoproximity"
                    : ctx.attrs?.cidrRoutingConfig !== undefined
                      ? "ip-based"
                      : undefined,
    },
  ],
});

export const HealthCheckUI = UIProvider.succeed<HealthCheck>(
  "AWS.Route53.HealthCheck",
  {
    displayName: "Route 53 Health Check",
    icon: "heart-pulse",
    color: COLOR,
    category: "dns",
    summary: (ctx) => ctx.attrs?.id,
    facts: (ctx) => [
      {
        label: "health check id",
        value: ctx.attrs?.healthCheckId,
        mono: true,
        copy: true,
      },
      { label: "type", value: ctx.attrs?.type },
      {
        label: "endpoint",
        value:
          (ctx.props?.fullyQualifiedDomainName ?? ctx.props?.ipAddress)
            ? `${ctx.props?.fullyQualifiedDomainName ?? ctx.props?.ipAddress}${ctx.props?.port ? `:${ctx.props.port}` : ""}`
            : undefined,
        mono: true,
      },
      { label: "path", value: ctx.props?.resourcePath, mono: true },
    ],
  },
);

export const QueryLoggingConfigUI = UIProvider.succeed<QueryLoggingConfig>(
  "AWS.Route53.QueryLoggingConfig",
  {
    displayName: "Route 53 Query Logging Config",
    icon: "scroll-text",
    color: COLOR,
    category: "dns",
    summary: (ctx) => ctx.attrs?.hostedZoneId,
    consoleUrl: (ctx) =>
      ctx.attrs?.hostedZoneId === undefined
        ? undefined
        : `https://console.aws.amazon.com/route53/v2/hostedzones#ListRecordSets/${ctx.attrs.hostedZoneId}`,
    facts: (ctx) => [
      { label: "id", value: ctx.attrs?.id, mono: true, copy: true },
      {
        label: "zone id",
        value: ctx.attrs?.hostedZoneId,
        mono: true,
        copy: true,
      },
      {
        label: "log group",
        value: ctx.attrs?.cloudWatchLogsLogGroupArn,
        mono: true,
      },
    ],
  },
);

export const VpcAssociationAuthorizationUI =
  UIProvider.succeed<VpcAssociationAuthorization>(
    "AWS.Route53.VpcAssociationAuthorization",
    {
      displayName: "Route 53 VPC Association Authorization",
      icon: "key-round",
      color: COLOR,
      category: "auth",
      summary: (ctx) => ctx.attrs?.vpcId,
      facts: (ctx) => [
        {
          label: "zone id",
          value: ctx.attrs?.hostedZoneId,
          mono: true,
          copy: true,
        },
        { label: "vpc", value: ctx.attrs?.vpcId, mono: true, copy: true },
        { label: "region", value: ctx.attrs?.vpcRegion },
      ],
    },
  );

export const ZoneVpcAssociationUI = UIProvider.succeed<ZoneVpcAssociation>(
  "AWS.Route53.ZoneVpcAssociation",
  {
    displayName: "Route 53 Zone VPC Association",
    icon: "link",
    color: COLOR,
    category: "dns",
    summary: (ctx) => ctx.attrs?.vpcId,
    consoleUrl: (ctx) =>
      ctx.attrs?.hostedZoneId === undefined
        ? undefined
        : `https://console.aws.amazon.com/route53/v2/hostedzones#ListRecordSets/${ctx.attrs.hostedZoneId}`,
    facts: (ctx) => [
      {
        label: "zone id",
        value: ctx.attrs?.hostedZoneId,
        mono: true,
        copy: true,
      },
      { label: "vpc", value: ctx.attrs?.vpcId, mono: true, copy: true },
      { label: "region", value: ctx.attrs?.vpcRegion },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(
    HostedZoneUI,
    RecordUI,
    HealthCheckUI,
    QueryLoggingConfigUI,
    VpcAssociationAuthorizationUI,
    ZoneVpcAssociationUI,
  );
