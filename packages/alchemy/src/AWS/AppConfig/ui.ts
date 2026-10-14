import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Application } from "./Application.ts";
import type { ConfigurationProfile } from "./ConfigurationProfile.ts";
import type { Deployment } from "./Deployment.ts";
import type { DeploymentStrategy } from "./DeploymentStrategy.ts";
import type { Environment } from "./Environment.ts";
import type { Extension } from "./Extension.ts";
import type { ExtensionAssociation } from "./ExtensionAssociation.ts";
import type { HostedConfigurationVersion } from "./HostedConfigurationVersion.ts";

/**
 * Dashboard UI providers for AWS AppConfig resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const APPCONFIG_COLOR = "#E7157B";

export const ApplicationUI = UIProvider.succeed<Application>(
  "AWS.AppConfig.Application",
  {
    displayName: "AppConfig Application",
    icon: "package",
    color: APPCONFIG_COLOR,
    category: "config",
    summary: (ctx) => ctx.attrs?.applicationName,
    facts: (ctx) => [
      { label: "application", value: ctx.attrs?.applicationName, copy: true },
      { label: "id", value: ctx.attrs?.applicationId, mono: true },
      {
        label: "arn",
        value: ctx.attrs?.applicationArn,
        mono: true,
        copy: true,
      },
      { label: "description", value: ctx.props?.description },
    ],
  },
);

export const ConfigurationProfileUI = UIProvider.succeed<ConfigurationProfile>(
  "AWS.AppConfig.ConfigurationProfile",
  {
    displayName: "AppConfig Configuration Profile",
    icon: "file-text",
    color: APPCONFIG_COLOR,
    category: "config",
    summary: (ctx) => ctx.attrs?.configurationProfileName,
    facts: (ctx) => [
      {
        label: "profile",
        value: ctx.attrs?.configurationProfileName,
        copy: true,
      },
      { label: "id", value: ctx.attrs?.configurationProfileId, mono: true },
      { label: "application", value: ctx.attrs?.applicationId, mono: true },
      { label: "location", value: ctx.attrs?.locationUri, mono: true },
      {
        label: "arn",
        value: ctx.attrs?.configurationProfileArn,
        mono: true,
        copy: true,
      },
    ],
  },
);

export const DeploymentUI = UIProvider.succeed<Deployment>(
  "AWS.AppConfig.Deployment",
  {
    displayName: "AppConfig Deployment",
    icon: "upload",
    color: APPCONFIG_COLOR,
    category: "config",
    summary: (ctx) =>
      ctx.attrs?.deploymentNumber === undefined
        ? undefined
        : `deployment-${ctx.attrs.deploymentNumber}`,
    facts: (ctx) => [
      { label: "deployment", value: ctx.attrs?.deploymentNumber },
      { label: "application", value: ctx.attrs?.applicationId, mono: true },
      { label: "environment", value: ctx.attrs?.environmentId, mono: true },
      {
        label: "profile",
        value: ctx.attrs?.configurationProfileId,
        mono: true,
      },
      { label: "version", value: ctx.attrs?.configurationVersion },
      { label: "state", value: ctx.attrs?.state },
    ],
  },
);

export const DeploymentStrategyUI = UIProvider.succeed<DeploymentStrategy>(
  "AWS.AppConfig.DeploymentStrategy",
  {
    displayName: "AppConfig Deployment Strategy",
    icon: "workflow",
    color: APPCONFIG_COLOR,
    category: "config",
    summary: (ctx) => ctx.attrs?.deploymentStrategyName,
    facts: (ctx) => [
      {
        label: "strategy",
        value: ctx.attrs?.deploymentStrategyName,
        copy: true,
      },
      { label: "id", value: ctx.attrs?.deploymentStrategyId, mono: true },
      {
        label: "arn",
        value: ctx.attrs?.deploymentStrategyArn,
        mono: true,
        copy: true,
      },
      { label: "growth factor", value: ctx.props?.growthFactor },
      { label: "growth type", value: ctx.props?.growthType },
      { label: "replicate to", value: ctx.props?.replicateTo },
    ],
  },
);

export const EnvironmentUI = UIProvider.succeed<Environment>(
  "AWS.AppConfig.Environment",
  {
    displayName: "AppConfig Environment",
    icon: "layers",
    color: APPCONFIG_COLOR,
    category: "config",
    summary: (ctx) => ctx.attrs?.environmentName,
    facts: (ctx) => [
      { label: "environment", value: ctx.attrs?.environmentName, copy: true },
      { label: "id", value: ctx.attrs?.environmentId, mono: true },
      { label: "application", value: ctx.attrs?.applicationId, mono: true },
      {
        label: "arn",
        value: ctx.attrs?.environmentArn,
        mono: true,
        copy: true,
      },
      { label: "state", value: ctx.attrs?.state },
    ],
  },
);

export const ExtensionUI = UIProvider.succeed<Extension>(
  "AWS.AppConfig.Extension",
  {
    displayName: "AppConfig Extension",
    icon: "plug",
    color: APPCONFIG_COLOR,
    category: "config",
    summary: (ctx) => ctx.attrs?.extensionName,
    facts: (ctx) => [
      { label: "extension", value: ctx.attrs?.extensionName, copy: true },
      { label: "id", value: ctx.attrs?.extensionId, mono: true },
      { label: "arn", value: ctx.attrs?.extensionArn, mono: true, copy: true },
      { label: "version", value: ctx.attrs?.versionNumber },
      { label: "description", value: ctx.props?.description },
    ],
  },
);

export const ExtensionAssociationUI = UIProvider.succeed<ExtensionAssociation>(
  "AWS.AppConfig.ExtensionAssociation",
  {
    displayName: "AppConfig Extension Association",
    icon: "link",
    color: APPCONFIG_COLOR,
    category: "config",
    summary: (ctx) => ctx.attrs?.extensionAssociationId,
    facts: (ctx) => [
      {
        label: "association",
        value: ctx.attrs?.extensionAssociationId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.extensionAssociationArn,
        mono: true,
        copy: true,
      },
      { label: "extension", value: ctx.attrs?.extensionArn, mono: true },
      { label: "resource", value: ctx.attrs?.resourceArn, mono: true },
    ],
  },
);

export const HostedConfigurationVersionUI =
  UIProvider.succeed<HostedConfigurationVersion>(
    "AWS.AppConfig.HostedConfigurationVersion",
    {
      displayName: "AppConfig Hosted Configuration Version",
      icon: "scroll-text",
      color: APPCONFIG_COLOR,
      category: "config",
      summary: (ctx) =>
        ctx.attrs?.versionNumber === undefined
          ? undefined
          : `version-${ctx.attrs.versionNumber}`,
      facts: (ctx) => [
        { label: "application", value: ctx.attrs?.applicationId, mono: true },
        {
          label: "profile",
          value: ctx.attrs?.configurationProfileId,
          mono: true,
        },
        { label: "version", value: ctx.attrs?.versionNumber },
        { label: "content type", value: ctx.attrs?.contentType },
        { label: "label", value: ctx.attrs?.versionLabel },
      ],
    },
  );

export const ui = () =>
  Layer.mergeAll(
    ApplicationUI,
    ConfigurationProfileUI,
    DeploymentUI,
    DeploymentStrategyUI,
    EnvironmentUI,
    ExtensionUI,
    ExtensionAssociationUI,
    HostedConfigurationVersionUI,
  );
