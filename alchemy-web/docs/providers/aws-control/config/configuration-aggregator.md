---
title: Managing AWS Config ConfigurationAggregators with Alchemy
description: Learn how to create, update, and manage AWS Config ConfigurationAggregators using Alchemy Cloud Control.
---

# ConfigurationAggregator

The ConfigurationAggregator resource lets you create and manage [AWS Config ConfigurationAggregators](https://docs.aws.amazon.com/config/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-config-configurationaggregator.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const configurationaggregator = await AWS.Config.ConfigurationAggregator(
  "configurationaggregator-example",
  { Tags: { Environment: "production", ManagedBy: "Alchemy" } }
);
```

## Advanced Configuration

Create a configurationaggregator with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedConfigurationAggregator = await AWS.Config.ConfigurationAggregator(
  "advanced-configurationaggregator",
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

