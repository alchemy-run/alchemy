---
title: Managing AWS Deadline Farms with Alchemy
description: Learn how to create, update, and manage AWS Deadline Farms using Alchemy Cloud Control.
---

# Farm

The Farm resource lets you create and manage [AWS Deadline Farms](https://docs.aws.amazon.com/deadline/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-deadline-farm.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const farm = await AWS.Deadline.Farm("farm-example", {
  DisplayName: "farm-display",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A farm resource managed by Alchemy",
});
```

## Advanced Configuration

Create a farm with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedFarm = await AWS.Deadline.Farm("advanced-farm", {
  DisplayName: "farm-display",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A farm resource managed by Alchemy",
});
```

