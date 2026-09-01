import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Cluster } from "./Cluster.ts";
import type { SecurityConfiguration } from "./SecurityConfiguration.ts";
import type { Studio } from "./Studio.ts";

/**
 * Dashboard UI providers for AWS EMR resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS Analytics brand purple. */
const COLOR = "#8C4FFF";

const regionOf = (arn: string | undefined): string | undefined =>
  arn?.split(":")[3] || undefined;

export const ClusterUI = UIProvider.succeed<Cluster>("AWS.EMR.Cluster", {
  displayName: "EMR Cluster",
  icon: "server",
  color: COLOR,
  category: "compute",
  summary: (ctx) => ctx.attrs?.clusterName,
  consoleUrl: (ctx) => {
    const region = regionOf(ctx.attrs?.clusterArn);
    return region === undefined || ctx.attrs?.clusterId === undefined
      ? undefined
      : `https://${region}.console.aws.amazon.com/emr/home?region=${region}#/clusterDetails/${ctx.attrs.clusterId}`;
  },
  facts: (ctx) => [
    { label: "cluster", value: ctx.attrs?.clusterName, copy: true },
    { label: "id", value: ctx.attrs?.clusterId, mono: true, copy: true },
    { label: "arn", value: ctx.attrs?.clusterArn, mono: true, copy: true },
    { label: "state", value: ctx.attrs?.state },
    {
      label: "master dns",
      value: ctx.attrs?.masterPublicDnsName,
      mono: true,
    },
  ],
});

export const SecurityConfigurationUI =
  UIProvider.succeed<SecurityConfiguration>("AWS.EMR.SecurityConfiguration", {
    displayName: "EMR Security Configuration",
    icon: "shield",
    color: COLOR,
    category: "config",
    summary: (ctx) => ctx.attrs?.securityConfigurationName,
    facts: (ctx) => [
      {
        label: "configuration",
        value: ctx.attrs?.securityConfigurationName,
        copy: true,
      },
    ],
  });

export const StudioUI = UIProvider.succeed<Studio>("AWS.EMR.Studio", {
  displayName: "EMR Studio",
  icon: "notebook",
  color: COLOR,
  category: "other",
  summary: (ctx) => ctx.attrs?.studioName,
  link: (ctx) => ctx.attrs?.url,
  facts: (ctx) => [
    { label: "studio", value: ctx.attrs?.studioName, copy: true },
    { label: "id", value: ctx.attrs?.studioId, mono: true, copy: true },
    { label: "arn", value: ctx.attrs?.studioArn, mono: true, copy: true },
    {
      label: "url",
      value: ctx.attrs?.url,
      href: ctx.attrs?.url,
      copy: true,
    },
  ],
});

export const ui = () =>
  Layer.mergeAll(ClusterUI, SecurityConfigurationUI, StudioUI);
