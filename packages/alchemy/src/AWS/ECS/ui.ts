import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { CapacityProvider } from "./CapacityProvider.ts";
import type { Cluster } from "./Cluster.ts";
import type { Service } from "./Service.ts";
import type { Task } from "./Task.ts";
import type { TaskDefinition } from "./TaskDefinition.ts";

/**
 * Dashboard UI providers for AWS ECS resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const regionOf = (arn: string | undefined): string | undefined =>
  arn?.split(":")[3] || undefined;

export const ClusterUI = UIProvider.succeed<Cluster>("AWS.ECS.Cluster", {
  displayName: "ECS Cluster",
  icon: "boxes",
  color: "#ED7100",
  category: "compute",
  summary: (ctx) => ctx.attrs?.clusterName,
  consoleUrl: (ctx) => {
    const region = regionOf(ctx.attrs?.clusterArn);
    return region === undefined || ctx.attrs?.clusterName === undefined
      ? undefined
      : `https://${region}.console.aws.amazon.com/ecs/v2/clusters/${ctx.attrs.clusterName}?region=${region}`;
  },
  facts: (ctx) => [
    { label: "cluster", value: ctx.attrs?.clusterName, copy: true },
    { label: "arn", value: ctx.attrs?.clusterArn, mono: true, copy: true },
    { label: "status", value: ctx.attrs?.status },
    {
      label: "capacity providers",
      value: ctx.attrs?.capacityProviders?.length
        ? ctx.attrs.capacityProviders.join(", ")
        : undefined,
    },
  ],
});

export const TaskUI = UIProvider.succeed<Task>("AWS.ECS.Task", {
  displayName: "ECS Task",
  icon: "container",
  color: "#ED7100",
  category: "compute",
  summary: (ctx) => ctx.attrs?.taskFamily,
  facts: (ctx) => [
    { label: "family", value: ctx.attrs?.taskFamily, copy: true },
    {
      label: "task definition",
      value: ctx.attrs?.taskDefinitionArn,
      mono: true,
      copy: true,
    },
    { label: "container", value: ctx.attrs?.containerName },
    { label: "image", value: ctx.attrs?.imageUri, mono: true, copy: true },
    { label: "port", value: ctx.attrs?.port },
    { label: "log group", value: ctx.attrs?.logGroupName, mono: true },
    { label: "task role", value: ctx.attrs?.taskRoleArn, mono: true },
    { label: "code hash", value: ctx.attrs?.code?.hash, mono: true },
  ],
});

export const ServiceUI = UIProvider.succeed<Service>("AWS.ECS.Service", {
  displayName: "ECS Service",
  icon: "server",
  color: "#ED7100",
  category: "compute",
  summary: (ctx) => ctx.attrs?.serviceName,
  link: (ctx) => ctx.attrs?.url,
  consoleUrl: (ctx) => {
    const region = regionOf(ctx.attrs?.serviceArn);
    const clusterName = ctx.attrs?.clusterArn?.split("/")[1];
    return region === undefined ||
      clusterName === undefined ||
      ctx.attrs?.serviceName === undefined
      ? undefined
      : `https://${region}.console.aws.amazon.com/ecs/v2/clusters/${clusterName}/services/${ctx.attrs.serviceName}?region=${region}`;
  },
  facts: (ctx) => [
    { label: "service", value: ctx.attrs?.serviceName, copy: true },
    { label: "arn", value: ctx.attrs?.serviceArn, mono: true, copy: true },
    { label: "cluster", value: ctx.attrs?.clusterArn, mono: true },
    {
      label: "task definition",
      value: ctx.attrs?.taskDefinitionArn,
      mono: true,
    },
    { label: "status", value: ctx.attrs?.status },
    { label: "desired count", value: ctx.props?.desiredCount },
    {
      label: "url",
      value: ctx.attrs?.url,
      href: ctx.attrs?.url,
      copy: true,
    },
  ],
});

export const CapacityProviderUI = UIProvider.succeed<CapacityProvider>(
  "AWS.ECS.CapacityProvider",
  {
    displayName: "ECS Capacity Provider",
    icon: "layers",
    color: "#ED7100",
    category: "compute",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.capacityProviderArn,
        mono: true,
        copy: true,
      },
      { label: "status", value: ctx.attrs?.status },
      {
        label: "auto scaling group",
        value: ctx.attrs?.autoScalingGroupArn,
        mono: true,
      },
      {
        label: "managed scaling",
        value: ctx.attrs?.managedScaling?.status,
      },
      {
        label: "termination protection",
        value: ctx.attrs?.managedTerminationProtection,
      },
    ],
  },
);

export const TaskDefinitionUI = UIProvider.succeed<TaskDefinition>(
  "AWS.ECS.TaskDefinition",
  {
    displayName: "ECS Task Definition",
    icon: "scroll-text",
    color: "#ED7100",
    category: "compute",
    summary: (ctx) =>
      ctx.attrs?.family === undefined
        ? undefined
        : `${ctx.attrs.family}:${ctx.attrs.revision}`,
    consoleUrl: (ctx) => {
      const region = regionOf(ctx.attrs?.taskDefinitionArn);
      return region === undefined ||
        ctx.attrs?.family === undefined ||
        ctx.attrs?.revision === undefined
        ? undefined
        : `https://${region}.console.aws.amazon.com/ecs/v2/task-definitions/${ctx.attrs.family}/${ctx.attrs.revision}?region=${region}`;
    },
    facts: (ctx) => [
      { label: "family", value: ctx.attrs?.family, copy: true },
      { label: "revision", value: ctx.attrs?.revision },
      {
        label: "arn",
        value: ctx.attrs?.taskDefinitionArn,
        mono: true,
        copy: true,
      },
      { label: "container", value: ctx.attrs?.containerName },
      { label: "port", value: ctx.attrs?.port },
      { label: "task role", value: ctx.attrs?.taskRoleArn, mono: true },
      {
        label: "execution role",
        value: ctx.attrs?.executionRoleArn,
        mono: true,
      },
      { label: "log group", value: ctx.attrs?.logGroupName, mono: true },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(
    ClusterUI,
    TaskUI,
    ServiceUI,
    CapacityProviderUI,
    TaskDefinitionUI,
  );
