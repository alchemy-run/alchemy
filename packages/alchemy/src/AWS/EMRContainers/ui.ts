import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { JobTemplate } from "./JobTemplate.ts";
import type { VirtualCluster } from "./VirtualCluster.ts";

/**
 * Dashboard UI providers for AWS EMRContainers resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const COLOR = "#8C4FFF";

export const VirtualClusterUI = UIProvider.succeed<VirtualCluster>(
  "AWS.EMRContainers.VirtualCluster",
  {
    displayName: "EMR Virtual Cluster",
    icon: "boxes",
    color: COLOR,
    category: "other",
    summary: (ctx) => ctx.attrs?.virtualClusterName,
    facts: (ctx) => [
      {
        label: "cluster",
        value: ctx.attrs?.virtualClusterName,
        copy: true,
      },
      {
        label: "id",
        value: ctx.attrs?.virtualClusterId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.virtualClusterArn,
        mono: true,
        copy: true,
      },
      { label: "eks cluster", value: ctx.attrs?.eksClusterName, mono: true },
      { label: "state", value: ctx.attrs?.state },
    ],
  },
);

export const JobTemplateUI = UIProvider.succeed<JobTemplate>(
  "AWS.EMRContainers.JobTemplate",
  {
    displayName: "EMR Job Template",
    icon: "scroll-text",
    color: COLOR,
    category: "other",
    summary: (ctx) => ctx.attrs?.jobTemplateName,
    facts: (ctx) => [
      {
        label: "template",
        value: ctx.attrs?.jobTemplateName,
        copy: true,
      },
      {
        label: "id",
        value: ctx.attrs?.jobTemplateId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.jobTemplateArn,
        mono: true,
        copy: true,
      },
      {
        label: "release label",
        value: ctx.props?.jobTemplateData?.releaseLabel,
      },
    ],
  },
);

export const ui = () => Layer.mergeAll(VirtualClusterUI, JobTemplateUI);
