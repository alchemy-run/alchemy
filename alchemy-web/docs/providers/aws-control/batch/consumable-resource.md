---
title: Managing AWS Batch ConsumableResources with Alchemy
description: Learn how to create, update, and manage AWS Batch ConsumableResources using Alchemy Cloud Control.
---

# ConsumableResource

The ConsumableResource resource lets you create and manage [AWS Batch ConsumableResources](https://docs.aws.amazon.com/batch/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-batch-consumableresource.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const consumableresource = await AWS.Batch.ConsumableResource("consumableresource-example", {
  TotalQuantity: 1,
  ResourceType: "example-resourcetype",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a consumableresource with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedConsumableResource = await AWS.Batch.ConsumableResource(
  "advanced-consumableresource",
  {
    TotalQuantity: 1,
    ResourceType: "example-resourcetype",
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

