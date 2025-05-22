---
title: Managing AWS LaunchWizard Deployments with Alchemy
description: Learn how to create, update, and manage AWS LaunchWizard Deployments using Alchemy Cloud Control.
---

# Deployment

The Deployment resource lets you create and manage [AWS LaunchWizard Deployments](https://docs.aws.amazon.com/launchwizard/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-launchwizard-deployment.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const deployment = await AWS.LaunchWizard.Deployment("deployment-example", {
  WorkloadName: "deployment-workload",
  DeploymentPatternName: "deployment-deploymentpattern",
  Name: "deployment-",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a deployment with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedDeployment = await AWS.LaunchWizard.Deployment("advanced-deployment", {
  WorkloadName: "deployment-workload",
  DeploymentPatternName: "deployment-deploymentpattern",
  Name: "deployment-",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

