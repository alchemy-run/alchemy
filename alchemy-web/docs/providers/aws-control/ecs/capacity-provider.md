---
title: Managing AWS ECS CapacityProviders with Alchemy
description: Learn how to create, update, and manage AWS ECS CapacityProviders using Alchemy Cloud Control.
---

# CapacityProvider

The CapacityProvider resource lets you create and manage [AWS ECS CapacityProviders](https://docs.aws.amazon.com/ecs/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ecs-capacityprovider.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const capacityprovider = await AWS.ECS.CapacityProvider("capacityprovider-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a capacityprovider with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedCapacityProvider = await AWS.ECS.CapacityProvider("advanced-capacityprovider", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

