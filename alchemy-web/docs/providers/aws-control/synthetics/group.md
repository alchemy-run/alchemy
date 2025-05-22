---
title: Managing AWS Synthetics Groups with Alchemy
description: Learn how to create, update, and manage AWS Synthetics Groups using Alchemy Cloud Control.
---

# Group

The Group resource lets you create and manage [AWS Synthetics Groups](https://docs.aws.amazon.com/synthetics/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-synthetics-group.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const group = await AWS.Synthetics.Group("group-example", {
  Name: "group-",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a group with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedGroup = await AWS.Synthetics.Group("advanced-group", {
  Name: "group-",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

