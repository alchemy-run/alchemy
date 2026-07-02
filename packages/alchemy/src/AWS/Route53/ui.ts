import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { HealthCheck } from "./HealthCheck.ts";
import type { HostedZone } from "./HostedZone.ts";
import type { Record } from "./Record.ts";

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

export const ui = () => Layer.mergeAll(HostedZoneUI, RecordUI, HealthCheckUI);
