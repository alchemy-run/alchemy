---
title: Managing AWS XRay Groups with Alchemy
description: Learn how to create, update, and manage AWS XRay Groups using Alchemy Cloud Control.
---

# Group

The Group resource lets you create and manage [AWS XRay Groups](https://docs.aws.amazon.com/xray/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-xray-group.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const group = await AWS.XRay.Group("group-example", {
  GroupName: "group-group",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a group with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedGroup = await AWS.XRay.Group("advanced-group", {
  GroupName: "group-group",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

