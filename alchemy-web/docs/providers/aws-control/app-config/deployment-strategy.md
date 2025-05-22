---
title: Managing AWS AppConfig DeploymentStrategys with Alchemy
description: Learn how to create, update, and manage AWS AppConfig DeploymentStrategys using Alchemy Cloud Control.
---

# DeploymentStrategy

The DeploymentStrategy resource lets you create and manage [AWS AppConfig DeploymentStrategys](https://docs.aws.amazon.com/appconfig/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-appconfig-deploymentstrategy.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const deploymentstrategy = await AWS.AppConfig.DeploymentStrategy("deploymentstrategy-example", {
  ReplicateTo: "example-replicateto",
  DeploymentDurationInMinutes: 1,
  GrowthFactor: 1,
  Name: "deploymentstrategy-",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A deploymentstrategy resource managed by Alchemy",
});
```

## Advanced Configuration

Create a deploymentstrategy with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedDeploymentStrategy = await AWS.AppConfig.DeploymentStrategy(
  "advanced-deploymentstrategy",
  {
    ReplicateTo: "example-replicateto",
    DeploymentDurationInMinutes: 1,
    GrowthFactor: 1,
    Name: "deploymentstrategy-",
    Tags: {
      Environment: "production",
      Team: "DevOps",
      Project: "MyApp",
      CostCenter: "Engineering",
      ManagedBy: "Alchemy",
    },
    Description: "A deploymentstrategy resource managed by Alchemy",
  }
);
```

