import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Certificate } from "./Certificate.ts";
import type { Configuration } from "./Configuration.ts";
import type { List } from "./List.ts";
import type { Location } from "./Location.ts";
import type { Logging } from "./Logging.ts";
import type { ProxyEndpoint } from "./ProxyEndpoint.ts";
import type { Rule } from "./Rule.ts";

/**
 * Dashboard UI providers for Cloudflare Zero Trust Gateway resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const CertificateUI = UIProvider.succeed<Certificate>(
  "Cloudflare.Gateway.Certificate",
  {
    displayName: "Gateway Certificate",
    icon: "file-lock-2",
    color: "#F6821F",
    category: "security",
    summary: (ctx) => ctx.attrs?.certificateId,
    facts: (ctx) => [
      { label: "id", value: ctx.attrs?.certificateId, mono: true, copy: true },
      {
        label: "fingerprint",
        value: ctx.attrs?.fingerprint,
        mono: true,
        copy: true,
      },
      { label: "type", value: ctx.attrs?.certificateType },
      { label: "binding status", value: ctx.attrs?.bindingStatus },
      { label: "in use", value: ctx.attrs?.inUse },
      { label: "issuer", value: ctx.attrs?.issuerOrg },
      { label: "expires", value: ctx.attrs?.expiresOn },
    ],
  },
);

export const ConfigurationUI = UIProvider.succeed<Configuration>(
  "Cloudflare.Gateway.Configuration",
  {
    displayName: "Gateway Configuration",
    icon: "settings-2",
    color: "#F6821F",
    category: "config",
    summary: (ctx) => ctx.attrs?.accountId,
    facts: (ctx) => [
      { label: "account", value: ctx.attrs?.accountId, mono: true, copy: true },
      { label: "created", value: ctx.attrs?.createdAt },
      { label: "updated", value: ctx.attrs?.updatedAt },
    ],
  },
);

export const ListUI = UIProvider.succeed<List>("Cloudflare.Gateway.List", {
  displayName: "Gateway List",
  icon: "list-ordered",
  color: "#F6821F",
  category: "security",
  summary: (ctx) => ctx.attrs?.name,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name },
    { label: "id", value: ctx.attrs?.listId, mono: true, copy: true },
    { label: "type", value: ctx.attrs?.type },
    { label: "items", value: ctx.attrs?.count },
    { label: "description", value: ctx.attrs?.description || undefined },
  ],
});

export const LocationUI = UIProvider.succeed<Location>(
  "Cloudflare.Gateway.Location",
  {
    displayName: "Gateway Location",
    icon: "map-pin",
    color: "#F6821F",
    category: "network",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name },
      { label: "id", value: ctx.attrs?.locationId, mono: true, copy: true },
      {
        label: "doh",
        value:
          ctx.attrs?.dohSubdomain === undefined
            ? undefined
            : `${ctx.attrs.dohSubdomain}.cloudflare-gateway.com`,
        mono: true,
        copy: true,
      },
      { label: "ipv6", value: ctx.attrs?.ip, mono: true, copy: true },
      { label: "dns ipv4", value: ctx.attrs?.ipv4Destination, mono: true },
      { label: "client default", value: ctx.attrs?.clientDefault },
      { label: "ecs support", value: ctx.attrs?.ecsSupport },
    ],
  },
);

const logLevel = (settings?: {
  logAll?: boolean;
  logBlocks?: boolean;
}): string | undefined =>
  settings === undefined
    ? undefined
    : settings.logAll
      ? "log all"
      : settings.logBlocks
        ? "log blocks"
        : "off";

export const LoggingUI = UIProvider.succeed<Logging>(
  "Cloudflare.Gateway.Logging",
  {
    displayName: "Gateway Logging",
    icon: "scroll-text",
    color: "#F6821F",
    category: "observability",
    summary: (ctx) => ctx.attrs?.accountId,
    facts: (ctx) => [
      { label: "account", value: ctx.attrs?.accountId, mono: true, copy: true },
      { label: "redact PII", value: ctx.attrs?.redactPii },
      { label: "dns", value: logLevel(ctx.attrs?.dns) },
      { label: "http", value: logLevel(ctx.attrs?.http) },
      { label: "l4", value: logLevel(ctx.attrs?.l4) },
    ],
  },
);

export const ProxyEndpointUI = UIProvider.succeed<ProxyEndpoint>(
  "Cloudflare.Gateway.ProxyEndpoint",
  {
    displayName: "Gateway Proxy Endpoint",
    icon: "waypoints",
    color: "#F6821F",
    category: "network",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name },
      {
        label: "id",
        value: ctx.attrs?.proxyEndpointId,
        mono: true,
        copy: true,
      },
      { label: "kind", value: ctx.attrs?.kind },
      {
        label: "proxy host",
        value:
          ctx.attrs?.subdomain === undefined
            ? undefined
            : `${ctx.attrs.subdomain}.proxy.cloudflare-gateway.com`,
        mono: true,
        copy: true,
      },
      {
        label: "allowed ips",
        value: ctx.attrs?.ips?.length ? ctx.attrs.ips.join(", ") : undefined,
        mono: true,
      },
    ],
  },
);

export const RuleUI = UIProvider.succeed<Rule>("Cloudflare.Gateway.Rule", {
  displayName: "Gateway Rule",
  icon: "shield",
  color: "#F6821F",
  category: "security",
  summary: (ctx) => ctx.attrs?.name,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name },
    { label: "id", value: ctx.attrs?.ruleId, mono: true, copy: true },
    { label: "action", value: ctx.attrs?.action },
    {
      label: "filters",
      value: ctx.attrs?.filters?.length
        ? ctx.attrs.filters.join(", ")
        : undefined,
    },
    { label: "precedence", value: ctx.attrs?.precedence },
    { label: "traffic", value: ctx.props?.traffic, mono: true },
  ],
});

export const ui = () =>
  Layer.mergeAll(
    CertificateUI,
    ConfigurationUI,
    ListUI,
    LocationUI,
    LoggingUI,
    ProxyEndpointUI,
    RuleUI,
  );
