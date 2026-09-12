import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { AccessLogSubscription } from "./AccessLogSubscription.ts";
import type { AuthPolicy } from "./AuthPolicy.ts";
import type { Listener } from "./Listener.ts";
import type { ResourcePolicy } from "./ResourcePolicy.ts";
import type { Rule } from "./Rule.ts";
import type { Service } from "./Service.ts";
import type { ServiceNetwork } from "./ServiceNetwork.ts";
import type { ServiceNetworkServiceAssociation } from "./ServiceNetworkServiceAssociation.ts";
import type { ServiceNetworkVpcAssociation } from "./ServiceNetworkVpcAssociation.ts";
import type { TargetGroup } from "./TargetGroup.ts";

/**
 * Dashboard UI providers for AWS VpcLattice resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const COLOR = "#8C4FFF";

export const ServiceNetworkUI = UIProvider.succeed<ServiceNetwork>(
  "AWS.VpcLattice.ServiceNetwork",
  {
    displayName: "VPC Lattice Service Network",
    icon: "network",
    color: COLOR,
    category: "network",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "network", value: ctx.attrs?.name, copy: true },
      {
        label: "id",
        value: ctx.attrs?.serviceNetworkId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.serviceNetworkArn,
        mono: true,
        copy: true,
      },
      { label: "auth type", value: ctx.attrs?.authType },
    ],
  },
);

export const ServiceUI = UIProvider.succeed<Service>("AWS.VpcLattice.Service", {
  displayName: "VPC Lattice Service",
  icon: "share-2",
  color: COLOR,
  category: "network",
  summary: (ctx) => ctx.attrs?.name,
  facts: (ctx) => [
    { label: "service", value: ctx.attrs?.name, copy: true },
    { label: "id", value: ctx.attrs?.serviceId, mono: true, copy: true },
    { label: "arn", value: ctx.attrs?.serviceArn, mono: true, copy: true },
    { label: "status", value: ctx.attrs?.status },
    { label: "dns name", value: ctx.attrs?.dnsName, mono: true, copy: true },
    { label: "auth type", value: ctx.attrs?.authType },
  ],
});

export const ListenerUI = UIProvider.succeed<Listener>(
  "AWS.VpcLattice.Listener",
  {
    displayName: "VPC Lattice Listener",
    icon: "plug",
    color: COLOR,
    category: "network",
    summary: (ctx) =>
      ctx.attrs?.protocol === undefined
        ? ctx.attrs?.name
        : `${ctx.attrs.protocol}${ctx.attrs.port ? `:${ctx.attrs.port}` : ""}`,
    facts: (ctx) => [
      { label: "listener", value: ctx.attrs?.name, copy: true },
      { label: "id", value: ctx.attrs?.listenerId, mono: true, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.listenerArn,
        mono: true,
        copy: true,
      },
      { label: "protocol", value: ctx.attrs?.protocol },
      { label: "port", value: ctx.attrs?.port },
      { label: "service", value: ctx.attrs?.serviceId, mono: true },
    ],
  },
);

export const RuleUI = UIProvider.succeed<Rule>("AWS.VpcLattice.Rule", {
  displayName: "VPC Lattice Rule",
  icon: "filter",
  color: COLOR,
  category: "network",
  summary: (ctx) => ctx.attrs?.name,
  facts: (ctx) => [
    { label: "rule", value: ctx.attrs?.name, copy: true },
    { label: "id", value: ctx.attrs?.ruleId, mono: true, copy: true },
    { label: "arn", value: ctx.attrs?.ruleArn, mono: true, copy: true },
    { label: "priority", value: ctx.attrs?.priority },
    { label: "listener", value: ctx.attrs?.listenerIdentifier, mono: true },
  ],
});

export const TargetGroupUI = UIProvider.succeed<TargetGroup>(
  "AWS.VpcLattice.TargetGroup",
  {
    displayName: "VPC Lattice Target Group",
    icon: "boxes",
    color: COLOR,
    category: "network",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "target group", value: ctx.attrs?.name, copy: true },
      {
        label: "id",
        value: ctx.attrs?.targetGroupId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.targetGroupArn,
        mono: true,
        copy: true,
      },
      { label: "type", value: ctx.attrs?.type },
      { label: "status", value: ctx.attrs?.status },
      {
        label: "targets",
        value: ctx.props?.targets?.length,
      },
    ],
  },
);

export const AccessLogSubscriptionUI =
  UIProvider.succeed<AccessLogSubscription>(
    "AWS.VpcLattice.AccessLogSubscription",
    {
      displayName: "VPC Lattice Access Log Subscription",
      icon: "scroll-text",
      color: COLOR,
      category: "observability",
      summary: (ctx) => ctx.attrs?.destinationArn,
      facts: (ctx) => [
        {
          label: "id",
          value: ctx.attrs?.accessLogSubscriptionId,
          mono: true,
          copy: true,
        },
        {
          label: "arn",
          value: ctx.attrs?.accessLogSubscriptionArn,
          mono: true,
          copy: true,
        },
        { label: "resource", value: ctx.attrs?.resourceId, mono: true },
        {
          label: "destination",
          value: ctx.attrs?.destinationArn,
          mono: true,
          copy: true,
        },
      ],
    },
  );

export const AuthPolicyUI = UIProvider.succeed<AuthPolicy>(
  "AWS.VpcLattice.AuthPolicy",
  {
    displayName: "VPC Lattice Auth Policy",
    icon: "shield",
    color: COLOR,
    category: "security",
    summary: (ctx) => ctx.attrs?.resourceIdentifier,
    facts: (ctx) => [
      {
        label: "resource",
        value: ctx.attrs?.resourceIdentifier,
        mono: true,
        copy: true,
      },
      { label: "state", value: ctx.attrs?.state },
      { label: "policy", value: ctx.attrs?.policy, mono: true, copy: true },
    ],
  },
);

export const ResourcePolicyUI = UIProvider.succeed<ResourcePolicy>(
  "AWS.VpcLattice.ResourcePolicy",
  {
    displayName: "VPC Lattice Resource Policy",
    icon: "shield",
    color: COLOR,
    category: "security",
    summary: (ctx) => ctx.attrs?.resourceArn,
    facts: (ctx) => [
      {
        label: "resource",
        value: ctx.attrs?.resourceArn,
        mono: true,
        copy: true,
      },
      { label: "policy", value: ctx.attrs?.policy, mono: true, copy: true },
    ],
  },
);

export const ServiceNetworkServiceAssociationUI =
  UIProvider.succeed<ServiceNetworkServiceAssociation>(
    "AWS.VpcLattice.ServiceNetworkServiceAssociation",
    {
      displayName: "Service Network / Service Association",
      icon: "link",
      color: COLOR,
      category: "network",
      summary: (ctx) => ctx.attrs?.dnsName ?? ctx.attrs?.associationId,
      facts: (ctx) => [
        {
          label: "id",
          value: ctx.attrs?.associationId,
          mono: true,
          copy: true,
        },
        {
          label: "arn",
          value: ctx.attrs?.associationArn,
          mono: true,
          copy: true,
        },
        {
          label: "service network",
          value: ctx.attrs?.serviceNetworkId,
          mono: true,
        },
        { label: "service", value: ctx.attrs?.serviceId, mono: true },
        { label: "status", value: ctx.attrs?.status },
      ],
    },
  );

export const ServiceNetworkVpcAssociationUI =
  UIProvider.succeed<ServiceNetworkVpcAssociation>(
    "AWS.VpcLattice.ServiceNetworkVpcAssociation",
    {
      displayName: "Service Network / VPC Association",
      icon: "link",
      color: COLOR,
      category: "network",
      summary: (ctx) => ctx.attrs?.vpcId ?? ctx.attrs?.associationId,
      facts: (ctx) => [
        {
          label: "id",
          value: ctx.attrs?.associationId,
          mono: true,
          copy: true,
        },
        {
          label: "arn",
          value: ctx.attrs?.associationArn,
          mono: true,
          copy: true,
        },
        {
          label: "service network",
          value: ctx.attrs?.serviceNetworkId,
          mono: true,
        },
        { label: "vpc", value: ctx.attrs?.vpcId, mono: true },
        { label: "status", value: ctx.attrs?.status },
      ],
    },
  );

export const ui = () =>
  Layer.mergeAll(
    ServiceNetworkUI,
    ServiceUI,
    ListenerUI,
    RuleUI,
    TargetGroupUI,
    AccessLogSubscriptionUI,
    AuthPolicyUI,
    ResourcePolicyUI,
    ServiceNetworkServiceAssociationUI,
    ServiceNetworkVpcAssociationUI,
  );
