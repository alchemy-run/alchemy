---
title: Managing AWS AppConfig Deployments with Alchemy
description: Learn how to create, update, and manage AWS AppConfig Deployments using Alchemy Cloud Control.
---

# Deployment

The Deployment resource lets you create and manage [AWS AppConfig Deployments](https://docs.aws.amazon.com/appconfig/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-appconfig-deployment.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const deployment = await AWS.AppConfig.Deployment("deployment-example", {
  DeploymentStrategyId: "example-deploymentstrategyid",
  ConfigurationProfileId: "example-configurationprofileid",
  EnvironmentId: "example-environmentid",
  ConfigurationVersion: "example-configurationversion",
  ApplicationId: "example-applicationid",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A deployment resource managed by Alchemy",
});
```

## Advanced Configuration

Create a deployment with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedDeployment = await AWS.AppConfig.Deployment("advanced-deployment", {
  DeploymentStrategyId: "example-deploymentstrategyid",
  ConfigurationProfileId: "example-configurationprofileid",
  EnvironmentId: "example-environmentid",
  ConfigurationVersion: "example-configurationversion",
  ApplicationId: "example-applicationid",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A deployment resource managed by Alchemy",
});
```

