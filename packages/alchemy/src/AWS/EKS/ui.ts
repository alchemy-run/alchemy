import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { AccessEntry } from "./AccessEntry.ts";
import type { Addon } from "./Addon.ts";
import type { Cluster } from "./Cluster.ts";
import type { FargateProfile } from "./FargateProfile.ts";
import type { HelmChart } from "./HelmChart.ts";
import type { Manifest } from "./Manifest.ts";
import type { Nodegroup } from "./Nodegroup.ts";
import type { PodIdentityAssociation } from "./PodIdentityAssociation.ts";

/**
 * Dashboard UI providers for AWS EKS resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const regionOf = (arn: string | undefined): string | undefined =>
  arn?.split(":")[3] || undefined;

export const ClusterUI = UIProvider.succeed<Cluster>("AWS.EKS.Cluster", {
  displayName: "EKS Cluster",
  icon: "ship",
  color: "#ED7100",
  category: "compute",
  summary: (ctx) => ctx.attrs?.clusterName,
  consoleUrl: (ctx) => {
    const region = regionOf(ctx.attrs?.clusterArn);
    return region === undefined || ctx.attrs?.clusterName === undefined
      ? undefined
      : `https://${region}.console.aws.amazon.com/eks/home?region=${region}#/clusters/${ctx.attrs.clusterName}`;
  },
  facts: (ctx) => [
    { label: "cluster", value: ctx.attrs?.clusterName, copy: true },
    { label: "arn", value: ctx.attrs?.clusterArn, mono: true, copy: true },
    { label: "status", value: ctx.attrs?.status },
    { label: "version", value: ctx.attrs?.version },
    {
      label: "endpoint",
      value: ctx.attrs?.endpoint,
      mono: true,
      copy: true,
    },
    { label: "role", value: ctx.attrs?.roleArn, mono: true },
    { label: "oidc issuer", value: ctx.attrs?.oidcIssuer, mono: true },
  ],
});

export const AddonUI = UIProvider.succeed<Addon>("AWS.EKS.Addon", {
  displayName: "EKS Add-on",
  icon: "puzzle",
  color: "#ED7100",
  category: "config",
  summary: (ctx) => ctx.attrs?.addonName,
  facts: (ctx) => [
    { label: "add-on", value: ctx.attrs?.addonName, copy: true },
    { label: "arn", value: ctx.attrs?.addonArn, mono: true, copy: true },
    { label: "cluster", value: ctx.attrs?.clusterName },
    { label: "version", value: ctx.attrs?.addonVersion, mono: true },
    { label: "status", value: ctx.attrs?.status },
    { label: "namespace", value: ctx.attrs?.namespace },
  ],
});

export const PodIdentityAssociationUI =
  UIProvider.succeed<PodIdentityAssociation>("AWS.EKS.PodIdentityAssociation", {
    displayName: "EKS Pod Identity",
    icon: "key-round",
    color: "#ED7100",
    category: "auth",
    summary: (ctx) =>
      ctx.attrs?.namespace === undefined ||
      ctx.attrs?.serviceAccount === undefined
        ? undefined
        : `${ctx.attrs.namespace}/${ctx.attrs.serviceAccount}`,
    facts: (ctx) => [
      {
        label: "arn",
        value: ctx.attrs?.associationArn,
        mono: true,
        copy: true,
      },
      { label: "id", value: ctx.attrs?.associationId, mono: true },
      { label: "cluster", value: ctx.attrs?.clusterName },
      { label: "namespace", value: ctx.attrs?.namespace },
      { label: "service account", value: ctx.attrs?.serviceAccount },
      { label: "role", value: ctx.attrs?.roleArn, mono: true, copy: true },
    ],
  });

export const AccessEntryUI = UIProvider.succeed<AccessEntry>(
  "AWS.EKS.AccessEntry",
  {
    displayName: "EKS Access Entry",
    icon: "user-check",
    color: "#ED7100",
    category: "auth",
    summary: (ctx) => ctx.attrs?.principalArn,
    facts: (ctx) => [
      {
        label: "principal",
        value: ctx.attrs?.principalArn,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.accessEntryArn,
        mono: true,
        copy: true,
      },
      { label: "cluster", value: ctx.attrs?.clusterName },
      { label: "username", value: ctx.attrs?.username },
      { label: "type", value: ctx.attrs?.type },
      {
        label: "kubernetes groups",
        value: ctx.attrs?.kubernetesGroups?.length
          ? ctx.attrs.kubernetesGroups.join(", ")
          : undefined,
      },
    ],
  },
);

export const FargateProfileUI = UIProvider.succeed<FargateProfile>(
  "AWS.EKS.FargateProfile",
  {
    displayName: "EKS Fargate Profile",
    icon: "cloud",
    color: "#ED7100",
    category: "compute",
    summary: (ctx) => ctx.attrs?.fargateProfileName,
    facts: (ctx) => [
      {
        label: "profile",
        value: ctx.attrs?.fargateProfileName,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.fargateProfileArn,
        mono: true,
        copy: true,
      },
      { label: "cluster", value: ctx.attrs?.clusterName },
      { label: "status", value: ctx.attrs?.status },
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

export const HelmChartUI = UIProvider.succeed<HelmChart>("AWS.EKS.HelmChart", {
  displayName: "EKS Helm Chart",
  icon: "package",
  color: "#ED7100",
  category: "config",
  summary: (ctx) => ctx.attrs?.releaseName,
  facts: (ctx) => [
    { label: "release", value: ctx.attrs?.releaseName, copy: true },
    { label: "cluster", value: ctx.attrs?.clusterName },
    { label: "namespace", value: ctx.attrs?.namespace },
    { label: "chart", value: ctx.attrs?.chart, mono: true },
    { label: "version", value: ctx.attrs?.version },
    { label: "code hash", value: ctx.attrs?.code?.hash, mono: true },
  ],
});

export const ManifestUI = UIProvider.succeed<Manifest>("AWS.EKS.Manifest", {
  displayName: "EKS Manifest",
  icon: "file-text",
  color: "#ED7100",
  category: "config",
  summary: (ctx) =>
    ctx.attrs?.kind === undefined
      ? ctx.attrs?.name
      : `${ctx.attrs.kind}/${ctx.attrs.name}`,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name, copy: true },
    { label: "cluster", value: ctx.attrs?.clusterName },
    { label: "kind", value: ctx.attrs?.kind },
    { label: "api version", value: ctx.attrs?.apiVersion, mono: true },
    { label: "namespace", value: ctx.attrs?.namespace },
    { label: "uid", value: ctx.attrs?.uid, mono: true, copy: true },
  ],
});

export const NodegroupUI = UIProvider.succeed<Nodegroup>("AWS.EKS.Nodegroup", {
  displayName: "EKS Node Group",
  icon: "cpu",
  color: "#ED7100",
  category: "compute",
  summary: (ctx) => ctx.attrs?.nodegroupName,
  facts: (ctx) => [
    { label: "node group", value: ctx.attrs?.nodegroupName, copy: true },
    {
      label: "arn",
      value: ctx.attrs?.nodegroupArn,
      mono: true,
      copy: true,
    },
    { label: "cluster", value: ctx.attrs?.clusterName },
    { label: "status", value: ctx.attrs?.status },
    { label: "capacity type", value: ctx.attrs?.capacityType },
    {
      label: "instance types",
      value: ctx.attrs?.instanceTypes?.length
        ? ctx.attrs.instanceTypes.join(", ")
        : undefined,
      mono: true,
    },
  ],
});

export const ui = () =>
  Layer.mergeAll(
    ClusterUI,
    AddonUI,
    PodIdentityAssociationUI,
    AccessEntryUI,
    FargateProfileUI,
    HelmChartUI,
    ManifestUI,
    NodegroupUI,
  );
