import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { AutoScalingConfiguration } from "./AutoScalingConfiguration.ts";
import type { ObservabilityConfiguration } from "./ObservabilityConfiguration.ts";
import type { VpcConnector } from "./VpcConnector.ts";

/**
 * Dashboard UI providers for AWS AppRunner resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

export const AutoScalingConfigurationUI =
  UIProvider.succeed<AutoScalingConfiguration>(
    "AWS.AppRunner.AutoScalingConfiguration",
    {
      displayName: "App Runner Auto Scaling Configuration",
      icon: "gauge",
      color: "#ED7100",
      category: "compute",
      summary: (ctx) => ctx.attrs?.autoScalingConfigurationName,
      facts: (ctx) => [
        {
          label: "name",
          value: ctx.attrs?.autoScalingConfigurationName,
          copy: true,
        },
        {
          label: "arn",
          value: ctx.attrs?.autoScalingConfigurationArn,
          mono: true,
          copy: true,
        },
        {
          label: "revision",
          value: ctx.attrs?.autoScalingConfigurationRevision,
        },
        { label: "max concurrency", value: ctx.attrs?.maxConcurrency },
        { label: "min size", value: ctx.attrs?.minSize },
        { label: "max size", value: ctx.attrs?.maxSize },
      ],
    },
  );

export const ObservabilityConfigurationUI =
  UIProvider.succeed<ObservabilityConfiguration>(
    "AWS.AppRunner.ObservabilityConfiguration",
    {
      displayName: "App Runner Observability Configuration",
      icon: "eye",
      color: "#ED7100",
      category: "observability",
      summary: (ctx) => ctx.attrs?.observabilityConfigurationName,
      facts: (ctx) => [
        {
          label: "name",
          value: ctx.attrs?.observabilityConfigurationName,
          copy: true,
        },
        {
          label: "arn",
          value: ctx.attrs?.observabilityConfigurationArn,
          mono: true,
          copy: true,
        },
        {
          label: "revision",
          value: ctx.attrs?.observabilityConfigurationRevision,
        },
        { label: "trace vendor", value: ctx.attrs?.traceVendor },
      ],
    },
  );

export const VpcConnectorUI = UIProvider.succeed<VpcConnector>(
  "AWS.AppRunner.VpcConnector",
  {
    displayName: "App Runner VPC Connector",
    icon: "network",
    color: "#ED7100",
    category: "network",
    summary: (ctx) => ctx.attrs?.vpcConnectorName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.vpcConnectorName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.vpcConnectorArn,
        mono: true,
        copy: true,
      },
      { label: "revision", value: ctx.attrs?.vpcConnectorRevision },
      { label: "status", value: ctx.attrs?.status },
      {
        label: "subnets",
        value: ctx.attrs?.subnets?.length
          ? ctx.attrs.subnets.join(", ")
          : undefined,
        mono: true,
      },
      {
        label: "security groups",
        value: ctx.attrs?.securityGroups?.length
          ? ctx.attrs.securityGroups.join(", ")
          : undefined,
        mono: true,
      },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(
    AutoScalingConfigurationUI,
    ObservabilityConfigurationUI,
    VpcConnectorUI,
  );
