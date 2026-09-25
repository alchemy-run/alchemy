import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Listener } from "./Listener.ts";
import type { ListenerCertificate } from "./ListenerCertificate.ts";
import type { ListenerRule } from "./ListenerRule.ts";
import type { LoadBalancer } from "./LoadBalancer.ts";
import type { TargetGroup } from "./TargetGroup.ts";
import type { TargetGroupAttachment } from "./TargetGroupAttachment.ts";
import type { TrustStore } from "./TrustStore.ts";

/**
 * Dashboard UI providers for AWS ELBv2 resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const regionOf = (arn: string | undefined): string | undefined =>
  arn?.split(":")[3] || undefined;

export const LoadBalancerUI = UIProvider.succeed<LoadBalancer>(
  "AWS.ELBv2.LoadBalancer",
  {
    displayName: "Load Balancer",
    icon: "network",
    color: "#ED7100",
    category: "network",
    summary: (ctx) => ctx.attrs?.loadBalancerName,
    consoleUrl: (ctx) => {
      const region = regionOf(ctx.attrs?.loadBalancerArn);
      return region === undefined
        ? undefined
        : `https://${region}.console.aws.amazon.com/ec2/home?region=${region}#LoadBalancers:`;
    },
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.loadBalancerName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.loadBalancerArn,
        mono: true,
        copy: true,
      },
      {
        label: "dns",
        value: ctx.attrs?.dnsName,
        mono: true,
        copy: true,
        href:
          ctx.attrs?.dnsName === undefined
            ? undefined
            : `http://${ctx.attrs.dnsName}`,
      },
      { label: "type", value: ctx.attrs?.type },
      { label: "scheme", value: ctx.attrs?.scheme },
      { label: "vpc", value: ctx.attrs?.vpcId, mono: true },
      {
        label: "subnets",
        value: ctx.attrs?.subnets?.length
          ? ctx.attrs.subnets.join(", ")
          : undefined,
        mono: true,
      },
    ],
  },
);

export const TargetGroupUI = UIProvider.succeed<TargetGroup>(
  "AWS.ELBv2.TargetGroup",
  {
    displayName: "Target Group",
    icon: "target",
    color: "#ED7100",
    category: "network",
    summary: (ctx) => ctx.attrs?.targetGroupName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.targetGroupName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.targetGroupArn,
        mono: true,
        copy: true,
      },
      { label: "protocol", value: ctx.attrs?.protocol },
      { label: "port", value: ctx.attrs?.port },
      { label: "target type", value: ctx.attrs?.targetType },
      { label: "vpc", value: ctx.attrs?.vpcId, mono: true },
    ],
  },
);

export const ListenerUI = UIProvider.succeed<Listener>("AWS.ELBv2.Listener", {
  displayName: "Listener",
  icon: "antenna",
  color: "#ED7100",
  category: "network",
  summary: (ctx) =>
    ctx.attrs?.protocol === undefined || ctx.attrs?.port === undefined
      ? undefined
      : `${ctx.attrs.protocol}:${ctx.attrs.port}`,
  facts: (ctx) => [
    { label: "arn", value: ctx.attrs?.listenerArn, mono: true, copy: true },
    { label: "protocol", value: ctx.attrs?.protocol },
    { label: "port", value: ctx.attrs?.port },
    {
      label: "load balancer",
      value: ctx.attrs?.loadBalancerArn,
      mono: true,
    },
    {
      label: "target group",
      value: ctx.attrs?.targetGroupArn,
      mono: true,
    },
  ],
});

export const ListenerRuleUI = UIProvider.succeed<ListenerRule>(
  "AWS.ELBv2.ListenerRule",
  {
    displayName: "Listener Rule",
    icon: "route",
    color: "#ED7100",
    category: "network",
    summary: (ctx) =>
      ctx.attrs?.priority === undefined
        ? undefined
        : `priority ${ctx.attrs.priority}`,
    facts: (ctx) => [
      { label: "arn", value: ctx.attrs?.ruleArn, mono: true, copy: true },
      { label: "listener", value: ctx.attrs?.listenerArn, mono: true },
      { label: "priority", value: ctx.attrs?.priority },
      { label: "default", value: ctx.attrs?.isDefault },
    ],
  },
);

export const TrustStoreUI = UIProvider.succeed<TrustStore>(
  "AWS.ELBv2.TrustStore",
  {
    displayName: "Trust Store",
    icon: "shield-check",
    color: "#ED7100",
    category: "security",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.trustStoreArn,
        mono: true,
        copy: true,
      },
      { label: "status", value: ctx.attrs?.status },
      {
        label: "ca certificates",
        value: ctx.attrs?.numberOfCaCertificates,
      },
    ],
  },
);

export const ListenerCertificateUI = UIProvider.succeed<ListenerCertificate>(
  "AWS.ELBv2.ListenerCertificate",
  {
    displayName: "Listener Certificate",
    icon: "shield-check",
    color: "#ED7100",
    category: "security",
    summary: (ctx) => ctx.attrs?.certificateArn,
    facts: (ctx) => [
      {
        label: "certificate",
        value: ctx.attrs?.certificateArn,
        mono: true,
        copy: true,
      },
      { label: "listener", value: ctx.attrs?.listenerArn, mono: true },
    ],
  },
);

export const TargetGroupAttachmentUI =
  UIProvider.succeed<TargetGroupAttachment>("AWS.ELBv2.TargetGroupAttachment", {
    displayName: "Target Group Attachment",
    icon: "link",
    color: "#ED7100",
    category: "network",
    summary: (ctx) => ctx.attrs?.targetId,
    facts: (ctx) => [
      { label: "target", value: ctx.attrs?.targetId, mono: true, copy: true },
      {
        label: "target group",
        value: ctx.attrs?.targetGroupArn,
        mono: true,
        copy: true,
      },
      { label: "port", value: ctx.attrs?.port },
      { label: "availability zone", value: ctx.attrs?.availabilityZone },
    ],
  });

export const ui = () =>
  Layer.mergeAll(
    LoadBalancerUI,
    TargetGroupUI,
    ListenerUI,
    ListenerRuleUI,
    TrustStoreUI,
    ListenerCertificateUI,
    TargetGroupAttachmentUI,
  );
