---
title: Managing AWS EC2 PlacementGroups with Alchemy
description: Learn how to create, update, and manage AWS EC2 PlacementGroups using Alchemy Cloud Control.
---

# PlacementGroup

The PlacementGroup resource lets you create and manage [AWS EC2 PlacementGroups](https://docs.aws.amazon.com/ec2/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ec2-placementgroup.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const placementgroup = await AWS.EC2.PlacementGroup("placementgroup-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a placementgroup with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedPlacementGroup = await AWS.EC2.PlacementGroup("advanced-placementgroup", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

