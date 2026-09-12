import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Application } from "./Application.ts";
import type { DeploymentConfig } from "./DeploymentConfig.ts";
import type { DeploymentGroup } from "./DeploymentGroup.ts";

/**
 * Dashboard UI providers for AWS CodeDeploy resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const COLOR = "#E7157B";

export const ApplicationUI = UIProvider.succeed<Application>(
  "AWS.CodeDeploy.Application",
  {
    displayName: "CodeDeploy Application",
    icon: "box",
    color: COLOR,
    category: "config",
    summary: (ctx) => ctx.attrs?.applicationName,
    facts: (ctx) => [
      {
        label: "application",
        value: ctx.attrs?.applicationName,
        copy: true,
      },
      {
        label: "id",
        value: ctx.attrs?.applicationId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.applicationArn,
        mono: true,
        copy: true,
      },
      { label: "compute platform", value: ctx.attrs?.computePlatform },
    ],
  },
);

export const DeploymentConfigUI = UIProvider.succeed<DeploymentConfig>(
  "AWS.CodeDeploy.DeploymentConfig",
  {
    displayName: "CodeDeploy Deployment Config",
    icon: "settings",
    color: COLOR,
    category: "config",
    summary: (ctx) => ctx.attrs?.deploymentConfigName,
    facts: (ctx) => [
      {
        label: "config",
        value: ctx.attrs?.deploymentConfigName,
        copy: true,
      },
      {
        label: "id",
        value: ctx.attrs?.deploymentConfigId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.deploymentConfigArn,
        mono: true,
        copy: true,
      },
      { label: "compute platform", value: ctx.attrs?.computePlatform },
    ],
  },
);

export const DeploymentGroupUI = UIProvider.succeed<DeploymentGroup>(
  "AWS.CodeDeploy.DeploymentGroup",
  {
    displayName: "CodeDeploy Deployment Group",
    icon: "workflow",
    color: COLOR,
    category: "config",
    summary: (ctx) => ctx.attrs?.deploymentGroupName,
    facts: (ctx) => [
      {
        label: "group",
        value: ctx.attrs?.deploymentGroupName,
        copy: true,
      },
      {
        label: "id",
        value: ctx.attrs?.deploymentGroupId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.deploymentGroupArn,
        mono: true,
        copy: true,
      },
      {
        label: "application",
        value: ctx.attrs?.applicationName,
        mono: true,
      },
      {
        label: "service role",
        value: ctx.attrs?.serviceRoleArn,
        mono: true,
      },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(ApplicationUI, DeploymentConfigUI, DeploymentGroupUI);
