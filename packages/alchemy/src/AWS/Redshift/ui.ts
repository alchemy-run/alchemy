import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Cluster } from "./Cluster.ts";
import type { ClusterParameterGroup } from "./ClusterParameterGroup.ts";
import type { ClusterSubnetGroup } from "./ClusterSubnetGroup.ts";
import type { EventSubscription } from "./EventSubscription.ts";

/**
 * Dashboard UI providers for AWS Redshift resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS Analytics brand purple. */
const COLOR = "#8C4FFF";

const regionOf = (arn: string | undefined): string | undefined =>
  arn?.split(":")[3] || undefined;

export const ClusterUI = UIProvider.succeed<Cluster>("AWS.Redshift.Cluster", {
  displayName: "Redshift Cluster",
  icon: "database",
  color: COLOR,
  category: "database",
  summary: (ctx) => ctx.attrs?.clusterIdentifier,
  consoleUrl: (ctx) => {
    const region = regionOf(ctx.attrs?.clusterArn);
    return region === undefined || ctx.attrs?.clusterIdentifier === undefined
      ? undefined
      : `https://${region}.console.aws.amazon.com/redshiftv2/home?region=${region}#cluster-details?cluster=${ctx.attrs.clusterIdentifier}`;
  },
  facts: (ctx) => [
    { label: "cluster", value: ctx.attrs?.clusterIdentifier, copy: true },
    { label: "arn", value: ctx.attrs?.clusterArn, mono: true, copy: true },
    { label: "status", value: ctx.attrs?.clusterStatus },
    { label: "node type", value: ctx.attrs?.nodeType },
    { label: "nodes", value: ctx.attrs?.numberOfNodes },
    {
      label: "endpoint",
      value: ctx.attrs?.endpointAddress
        ? `${ctx.attrs.endpointAddress}:${ctx.attrs.endpointPort ?? ""}`
        : undefined,
      mono: true,
      copy: true,
    },
    { label: "database", value: ctx.attrs?.dbName },
  ],
});

export const ClusterParameterGroupUI =
  UIProvider.succeed<ClusterParameterGroup>(
    "AWS.Redshift.ClusterParameterGroup",
    {
      displayName: "Redshift Cluster Parameter Group",
      icon: "settings",
      color: COLOR,
      category: "config",
      summary: (ctx) => ctx.attrs?.clusterParameterGroupName,
      facts: (ctx) => [
        {
          label: "group",
          value: ctx.attrs?.clusterParameterGroupName,
          copy: true,
        },
        {
          label: "arn",
          value: ctx.attrs?.clusterParameterGroupArn,
          mono: true,
          copy: true,
        },
        { label: "family", value: ctx.attrs?.family },
        { label: "description", value: ctx.attrs?.description },
      ],
    },
  );

export const ClusterSubnetGroupUI = UIProvider.succeed<ClusterSubnetGroup>(
  "AWS.Redshift.ClusterSubnetGroup",
  {
    displayName: "Redshift Cluster Subnet Group",
    icon: "network",
    color: COLOR,
    category: "network",
    summary: (ctx) => ctx.attrs?.clusterSubnetGroupName,
    facts: (ctx) => [
      {
        label: "group",
        value: ctx.attrs?.clusterSubnetGroupName,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.clusterSubnetGroupArn,
        mono: true,
        copy: true,
      },
      { label: "vpc", value: ctx.attrs?.vpcId, mono: true },
      {
        label: "subnets",
        value: ctx.attrs?.subnetIds?.length
          ? ctx.attrs.subnetIds.join(", ")
          : undefined,
        mono: true,
      },
      { label: "status", value: ctx.attrs?.subnetGroupStatus },
    ],
  },
);

export const EventSubscriptionUI = UIProvider.succeed<EventSubscription>(
  "AWS.Redshift.EventSubscription",
  {
    displayName: "Redshift Event Subscription",
    icon: "bell",
    color: COLOR,
    category: "eventing",
    summary: (ctx) => ctx.attrs?.subscriptionName,
    facts: (ctx) => [
      { label: "subscription", value: ctx.attrs?.subscriptionName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.eventSubscriptionArn,
        mono: true,
        copy: true,
      },
      { label: "topic", value: ctx.attrs?.snsTopicArn, mono: true },
      { label: "status", value: ctx.attrs?.status },
      { label: "source type", value: ctx.attrs?.sourceType },
      { label: "enabled", value: ctx.attrs?.enabled },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(
    ClusterUI,
    ClusterParameterGroupUI,
    ClusterSubnetGroupUI,
    EventSubscriptionUI,
  );
