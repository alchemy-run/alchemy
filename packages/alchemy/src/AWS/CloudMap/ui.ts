import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { HttpNamespace } from "./HttpNamespace.ts";
import type { InstanceRegistration } from "./InstanceRegistration.ts";
import type { PrivateDnsNamespace } from "./PrivateDnsNamespace.ts";
import type { PublicDnsNamespace } from "./PublicDnsNamespace.ts";
import type { Service } from "./Service.ts";

/**
 * Dashboard UI providers for AWS CloudMap resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const COLOR = "#8C4FFF";

export const HttpNamespaceUI = UIProvider.succeed<HttpNamespace>(
  "AWS.CloudMap.HttpNamespace",
  {
    displayName: "Cloud Map HTTP Namespace",
    icon: "waypoints",
    color: COLOR,
    category: "network",
    summary: (ctx) => ctx.attrs?.namespaceName,
    facts: (ctx) => [
      { label: "namespace", value: ctx.attrs?.namespaceName, copy: true },
      {
        label: "id",
        value: ctx.attrs?.namespaceId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.namespaceArn,
        mono: true,
        copy: true,
      },
      { label: "http name", value: ctx.attrs?.httpName, mono: true },
      { label: "description", value: ctx.props?.description },
    ],
  },
);

export const PrivateDnsNamespaceUI = UIProvider.succeed<PrivateDnsNamespace>(
  "AWS.CloudMap.PrivateDnsNamespace",
  {
    displayName: "Cloud Map Private DNS Namespace",
    icon: "globe",
    color: COLOR,
    category: "dns",
    summary: (ctx) => ctx.attrs?.namespaceName,
    facts: (ctx) => [
      { label: "namespace", value: ctx.attrs?.namespaceName, copy: true },
      {
        label: "id",
        value: ctx.attrs?.namespaceId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.namespaceArn,
        mono: true,
        copy: true,
      },
      {
        label: "hosted zone",
        value: ctx.attrs?.hostedZoneId,
        mono: true,
        copy: true,
      },
      { label: "vpc", value: ctx.props?.vpc, mono: true },
    ],
  },
);

export const PublicDnsNamespaceUI = UIProvider.succeed<PublicDnsNamespace>(
  "AWS.CloudMap.PublicDnsNamespace",
  {
    displayName: "Cloud Map Public DNS Namespace",
    icon: "globe",
    color: COLOR,
    category: "dns",
    summary: (ctx) => ctx.attrs?.namespaceName,
    facts: (ctx) => [
      { label: "namespace", value: ctx.attrs?.namespaceName, copy: true },
      {
        label: "id",
        value: ctx.attrs?.namespaceId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.namespaceArn,
        mono: true,
        copy: true,
      },
      {
        label: "hosted zone",
        value: ctx.attrs?.hostedZoneId,
        mono: true,
        copy: true,
      },
    ],
  },
);

export const ServiceUI = UIProvider.succeed<Service>("AWS.CloudMap.Service", {
  displayName: "Cloud Map Service",
  icon: "share-2",
  color: COLOR,
  category: "network",
  summary: (ctx) => ctx.attrs?.serviceName,
  facts: (ctx) => [
    { label: "service", value: ctx.attrs?.serviceName, copy: true },
    { label: "id", value: ctx.attrs?.serviceId, mono: true, copy: true },
    { label: "arn", value: ctx.attrs?.serviceArn, mono: true, copy: true },
    {
      label: "namespace",
      value: ctx.attrs?.namespaceName,
      mono: true,
    },
  ],
});

export const InstanceRegistrationUI = UIProvider.succeed<InstanceRegistration>(
  "AWS.CloudMap.InstanceRegistration",
  {
    displayName: "Cloud Map Instance Registration",
    icon: "plug",
    color: COLOR,
    category: "network",
    summary: (ctx) => ctx.attrs?.instanceId,
    facts: (ctx) => [
      { label: "instance", value: ctx.attrs?.instanceId, copy: true },
      {
        label: "service",
        value: ctx.attrs?.serviceId,
        mono: true,
        copy: true,
      },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(
    HttpNamespaceUI,
    PrivateDnsNamespaceUI,
    PublicDnsNamespaceUI,
    ServiceUI,
    InstanceRegistrationUI,
  );
