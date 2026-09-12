import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { AlertManagerDefinition } from "./AlertManagerDefinition.ts";
import type { AnomalyDetector } from "./AnomalyDetector.ts";
import type { LoggingConfiguration } from "./LoggingConfiguration.ts";
import type { QueryLoggingConfiguration } from "./QueryLoggingConfiguration.ts";
import type { ResourcePolicy } from "./ResourcePolicy.ts";
import type { RuleGroupsNamespace } from "./RuleGroupsNamespace.ts";
import type { Scraper } from "./Scraper.ts";
import type { ScraperLoggingConfiguration } from "./ScraperLoggingConfiguration.ts";
import type { Workspace } from "./Workspace.ts";

/**
 * Dashboard UI providers for AWS AMP (Managed Service for Prometheus)
 * resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS Management & Governance / Observability brand pink. */
const COLOR = "#E7157B";

const regionOf = (arn: string | undefined): string | undefined =>
  arn?.split(":")[3] || undefined;

export const WorkspaceUI = UIProvider.succeed<Workspace>("AWS.AMP.Workspace", {
  displayName: "AMP Workspace",
  icon: "chart-line",
  color: COLOR,
  category: "observability",
  summary: (ctx) => ctx.attrs?.alias ?? ctx.attrs?.workspaceId,
  consoleUrl: (ctx) => {
    const region = regionOf(ctx.attrs?.workspaceArn);
    return region === undefined || ctx.attrs?.workspaceId === undefined
      ? undefined
      : `https://${region}.console.aws.amazon.com/prometheus/home?region=${region}#/workspaces/${ctx.attrs.workspaceId}`;
  },
  facts: (ctx) => [
    {
      label: "workspace",
      value: ctx.attrs?.workspaceId,
      mono: true,
      copy: true,
    },
    { label: "arn", value: ctx.attrs?.workspaceArn, mono: true, copy: true },
    { label: "alias", value: ctx.attrs?.alias },
    { label: "status", value: ctx.attrs?.status },
    {
      label: "endpoint",
      value: ctx.attrs?.prometheusEndpoint,
      mono: true,
      copy: true,
    },
  ],
});

export const AlertManagerDefinitionUI =
  UIProvider.succeed<AlertManagerDefinition>("AWS.AMP.AlertManagerDefinition", {
    displayName: "AMP Alert Manager Definition",
    icon: "bell",
    color: COLOR,
    category: "observability",
    summary: (ctx) => ctx.attrs?.workspaceId,
    facts: (ctx) => [
      {
        label: "workspace",
        value: ctx.attrs?.workspaceId,
        mono: true,
        copy: true,
      },
      { label: "status", value: ctx.attrs?.status },
    ],
  });

export const AnomalyDetectorUI = UIProvider.succeed<AnomalyDetector>(
  "AWS.AMP.AnomalyDetector",
  {
    displayName: "AMP Anomaly Detector",
    icon: "activity",
    color: COLOR,
    category: "observability",
    summary: (ctx) => ctx.attrs?.alias,
    facts: (ctx) => [
      { label: "detector", value: ctx.attrs?.alias, copy: true },
      {
        label: "id",
        value: ctx.attrs?.anomalyDetectorId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.anomalyDetectorArn,
        mono: true,
        copy: true,
      },
      { label: "workspace", value: ctx.attrs?.workspaceId, mono: true },
      { label: "status", value: ctx.attrs?.status },
    ],
  },
);

export const LoggingConfigurationUI = UIProvider.succeed<LoggingConfiguration>(
  "AWS.AMP.LoggingConfiguration",
  {
    displayName: "AMP Logging Configuration",
    icon: "scroll-text",
    color: COLOR,
    category: "observability",
    summary: (ctx) => ctx.attrs?.workspaceId,
    facts: (ctx) => [
      {
        label: "workspace",
        value: ctx.attrs?.workspaceId,
        mono: true,
        copy: true,
      },
      {
        label: "log group",
        value: ctx.attrs?.logGroupArn,
        mono: true,
        copy: true,
      },
      { label: "status", value: ctx.attrs?.status },
    ],
  },
);

export const QueryLoggingConfigurationUI =
  UIProvider.succeed<QueryLoggingConfiguration>(
    "AWS.AMP.QueryLoggingConfiguration",
    {
      displayName: "AMP Query Logging Configuration",
      icon: "scroll-text",
      color: COLOR,
      category: "observability",
      summary: (ctx) => ctx.attrs?.workspaceId,
      facts: (ctx) => [
        {
          label: "workspace",
          value: ctx.attrs?.workspaceId,
          mono: true,
          copy: true,
        },
        {
          label: "destinations",
          value: ctx.attrs?.destinations?.length
            ? ctx.attrs.destinations.map((d) => d.logGroupArn).join(", ")
            : undefined,
          mono: true,
        },
        { label: "status", value: ctx.attrs?.status },
      ],
    },
  );

export const ResourcePolicyUI = UIProvider.succeed<ResourcePolicy>(
  "AWS.AMP.ResourcePolicy",
  {
    displayName: "AMP Resource Policy",
    icon: "shield",
    color: COLOR,
    category: "observability",
    summary: (ctx) => ctx.attrs?.workspaceId,
    facts: (ctx) => [
      {
        label: "workspace",
        value: ctx.attrs?.workspaceId,
        mono: true,
        copy: true,
      },
      { label: "status", value: ctx.attrs?.policyStatus },
      { label: "revision", value: ctx.attrs?.revisionId, mono: true },
    ],
  },
);

export const RuleGroupsNamespaceUI = UIProvider.succeed<RuleGroupsNamespace>(
  "AWS.AMP.RuleGroupsNamespace",
  {
    displayName: "AMP Rule Groups Namespace",
    icon: "list-ordered",
    color: COLOR,
    category: "observability",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "namespace", value: ctx.attrs?.name, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.ruleGroupsNamespaceArn,
        mono: true,
        copy: true,
      },
      { label: "workspace", value: ctx.attrs?.workspaceId, mono: true },
      { label: "status", value: ctx.attrs?.status },
    ],
  },
);

export const ScraperUI = UIProvider.succeed<Scraper>("AWS.AMP.Scraper", {
  displayName: "AMP Scraper",
  icon: "cable",
  color: COLOR,
  category: "observability",
  summary: (ctx) => ctx.attrs?.alias ?? ctx.attrs?.scraperId,
  facts: (ctx) => [
    { label: "scraper", value: ctx.attrs?.scraperId, mono: true, copy: true },
    { label: "arn", value: ctx.attrs?.scraperArn, mono: true, copy: true },
    { label: "alias", value: ctx.attrs?.alias },
    { label: "role", value: ctx.attrs?.roleArn, mono: true },
    { label: "status", value: ctx.attrs?.status },
  ],
});

export const ScraperLoggingConfigurationUI =
  UIProvider.succeed<ScraperLoggingConfiguration>(
    "AWS.AMP.ScraperLoggingConfiguration",
    {
      displayName: "AMP Scraper Logging Configuration",
      icon: "scroll-text",
      color: COLOR,
      category: "observability",
      summary: (ctx) => ctx.attrs?.scraperId,
      facts: (ctx) => [
        {
          label: "scraper",
          value: ctx.attrs?.scraperId,
          mono: true,
          copy: true,
        },
        {
          label: "log group",
          value: ctx.attrs?.logGroupArn,
          mono: true,
          copy: true,
        },
        { label: "status", value: ctx.attrs?.status },
      ],
    },
  );

export const ui = () =>
  Layer.mergeAll(
    WorkspaceUI,
    AlertManagerDefinitionUI,
    AnomalyDetectorUI,
    LoggingConfigurationUI,
    QueryLoggingConfigurationUI,
    ResourcePolicyUI,
    RuleGroupsNamespaceUI,
    ScraperUI,
    ScraperLoggingConfigurationUI,
  );
