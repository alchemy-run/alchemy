import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Cluster } from "./Cluster.ts";
import type { ClusterSchedulerConfig } from "./ClusterSchedulerConfig.ts";
import type { ComputeQuota } from "./ComputeQuota.ts";
import type { Endpoint } from "./Endpoint.ts";
import type { EndpointConfig } from "./EndpointConfig.ts";
import type { FeatureGroup } from "./FeatureGroup.ts";
import type { Model } from "./Model.ts";

/**
 * Dashboard UI providers for AWS SageMaker resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS machine learning & AI brand teal. */
const COLOR = "#01A88D";

/** Extract the region segment from an AWS ARN (`arn:aws:sagemaker:REGION:...`). */
const regionOfArn = (arn: string | undefined): string | undefined =>
  arn?.split(":")[3] || undefined;

export const ClusterUI = UIProvider.succeed<Cluster>("AWS.SageMaker.Cluster", {
  displayName: "HyperPod Cluster",
  icon: "server",
  color: COLOR,
  category: "ai",
  summary: (ctx) => ctx.attrs?.clusterName,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.clusterName, copy: true },
    { label: "arn", value: ctx.attrs?.clusterArn, mono: true, copy: true },
    { label: "status", value: ctx.attrs?.clusterStatus },
    {
      label: "eks cluster",
      value: ctx.attrs?.orchestratorEksClusterArn,
      mono: true,
    },
    {
      label: "instance groups",
      value: ctx.attrs?.instanceGroups
        ? Object.keys(ctx.attrs.instanceGroups).join(", ")
        : undefined,
    },
  ],
});

export const ClusterSchedulerConfigUI =
  UIProvider.succeed<ClusterSchedulerConfig>(
    "AWS.SageMaker.ClusterSchedulerConfig",
    {
      displayName: "HyperPod Cluster Policy",
      icon: "list-ordered",
      color: COLOR,
      category: "ai",
      summary: (ctx) => ctx.attrs?.name,
      facts: (ctx) => [
        { label: "name", value: ctx.attrs?.name, copy: true },
        {
          label: "arn",
          value: ctx.attrs?.clusterSchedulerConfigArn,
          mono: true,
          copy: true,
        },
        { label: "cluster", value: ctx.attrs?.clusterArn, mono: true },
        { label: "version", value: ctx.attrs?.clusterSchedulerConfigVersion },
      ],
    },
  );

export const ComputeQuotaUI = UIProvider.succeed<ComputeQuota>(
  "AWS.SageMaker.ComputeQuota",
  {
    displayName: "HyperPod Compute Quota",
    icon: "gauge",
    color: COLOR,
    category: "ai",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.computeQuotaArn,
        mono: true,
        copy: true,
      },
      { label: "cluster", value: ctx.attrs?.clusterArn, mono: true },
      { label: "team", value: ctx.attrs?.teamName },
      { label: "version", value: ctx.attrs?.computeQuotaVersion },
    ],
  },
);

export const EndpointUI = UIProvider.succeed<Endpoint>(
  "AWS.SageMaker.Endpoint",
  {
    displayName: "SageMaker Endpoint",
    icon: "plug-zap",
    color: COLOR,
    category: "ai",
    summary: (ctx) => ctx.attrs?.endpointName,
    consoleUrl: (ctx) => {
      const region = regionOfArn(ctx.attrs?.endpointArn);
      return region === undefined || ctx.attrs?.endpointName === undefined
        ? undefined
        : `https://${region}.console.aws.amazon.com/sagemaker/home?region=${region}#/endpoints/${ctx.attrs.endpointName}`;
    },
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.endpointName, copy: true },
      { label: "arn", value: ctx.attrs?.endpointArn, mono: true, copy: true },
      { label: "status", value: ctx.attrs?.endpointStatus },
      { label: "config", value: ctx.props?.endpointConfigName },
    ],
  },
);

export const EndpointConfigUI = UIProvider.succeed<EndpointConfig>(
  "AWS.SageMaker.EndpointConfig",
  {
    displayName: "SageMaker Endpoint Config",
    icon: "settings",
    color: COLOR,
    category: "ai",
    summary: (ctx) => ctx.attrs?.endpointConfigName,
    consoleUrl: (ctx) => {
      const region = regionOfArn(ctx.attrs?.endpointConfigArn);
      return region === undefined || ctx.attrs?.endpointConfigName === undefined
        ? undefined
        : `https://${region}.console.aws.amazon.com/sagemaker/home?region=${region}#/endpointConfig/${ctx.attrs.endpointConfigName}`;
    },
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.endpointConfigName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.endpointConfigArn,
        mono: true,
        copy: true,
      },
      {
        label: "variants",
        value: ctx.props?.productionVariants
          ?.map((v: { VariantName?: string }) => v.VariantName)
          .join(", "),
      },
    ],
  },
);

export const FeatureGroupUI = UIProvider.succeed<FeatureGroup>(
  "AWS.SageMaker.FeatureGroup",
  {
    displayName: "Feature Group",
    icon: "table",
    color: COLOR,
    category: "ai",
    summary: (ctx) => ctx.attrs?.featureGroupName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.featureGroupName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.featureGroupArn,
        mono: true,
        copy: true,
      },
      {
        label: "record identifier",
        value: ctx.attrs?.recordIdentifierFeatureName,
      },
      { label: "event time", value: ctx.attrs?.eventTimeFeatureName },
    ],
  },
);

export const ModelUI = UIProvider.succeed<Model>("AWS.SageMaker.Model", {
  displayName: "SageMaker Model",
  icon: "brain",
  color: COLOR,
  category: "ai",
  summary: (ctx) => ctx.attrs?.modelName,
  consoleUrl: (ctx) => {
    const region = regionOfArn(ctx.attrs?.modelArn);
    return region === undefined || ctx.attrs?.modelName === undefined
      ? undefined
      : `https://${region}.console.aws.amazon.com/sagemaker/home?region=${region}#/models/${ctx.attrs.modelName}`;
  },
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.modelName, copy: true },
    { label: "arn", value: ctx.attrs?.modelArn, mono: true, copy: true },
    { label: "execution role", value: ctx.props?.executionRoleArn, mono: true },
  ],
});

export const ui = () =>
  Layer.mergeAll(
    ClusterUI,
    ClusterSchedulerConfigUI,
    ComputeQuotaUI,
    EndpointUI,
    EndpointConfigUI,
    FeatureGroupUI,
    ModelUI,
  );
