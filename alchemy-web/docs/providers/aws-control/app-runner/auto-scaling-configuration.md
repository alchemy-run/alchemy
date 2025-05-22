---
title: Managing AWS AppRunner AutoScalingConfigurations with Alchemy
description: Learn how to create, update, and manage AWS AppRunner AutoScalingConfigurations using Alchemy Cloud Control.
---

# AutoScalingConfiguration

The AutoScalingConfiguration resource lets you create and manage [AWS AppRunner AutoScalingConfigurations](https://docs.aws.amazon.com/apprunner/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-apprunner-autoscalingconfiguration.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const autoscalingconfiguration = await AWS.AppRunner.AutoScalingConfiguration(
  "autoscalingconfiguration-example",
  { Tags: { Environment: "production", ManagedBy: "Alchemy" } }
);
```

## Advanced Configuration

Create a autoscalingconfiguration with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedAutoScalingConfiguration = await AWS.AppRunner.AutoScalingConfiguration(
  "advanced-autoscalingconfiguration",
  {
    Tags: {
      Environment: "production",
      Team: "DevOps",
      Project: "MyApp",
      CostCenter: "Engineering",
      ManagedBy: "Alchemy",
    },
  }
);
```

