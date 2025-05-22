---
title: Managing AWS ImageBuilder InfrastructureConfigurations with Alchemy
description: Learn how to create, update, and manage AWS ImageBuilder InfrastructureConfigurations using Alchemy Cloud Control.
---

# InfrastructureConfiguration

The InfrastructureConfiguration resource lets you create and manage [AWS ImageBuilder InfrastructureConfigurations](https://docs.aws.amazon.com/imagebuilder/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-imagebuilder-infrastructureconfiguration.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const infrastructureconfiguration = await AWS.ImageBuilder.InfrastructureConfiguration(
  "infrastructureconfiguration-example",
  {
    InstanceProfileName: "infrastructureconfiguration-instanceprofile",
    Name: "infrastructureconfiguration-",
    Tags: { Environment: "production", ManagedBy: "Alchemy" },
    Description: "A infrastructureconfiguration resource managed by Alchemy",
  }
);
```

## Advanced Configuration

Create a infrastructureconfiguration with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedInfrastructureConfiguration = await AWS.ImageBuilder.InfrastructureConfiguration(
  "advanced-infrastructureconfiguration",
  {
    InstanceProfileName: "infrastructureconfiguration-instanceprofile",
    Name: "infrastructureconfiguration-",
    Tags: {
      Environment: "production",
      Team: "DevOps",
      Project: "MyApp",
      CostCenter: "Engineering",
      ManagedBy: "Alchemy",
    },
    Description: "A infrastructureconfiguration resource managed by Alchemy",
    Logging: "example-logging",
  }
);
```

