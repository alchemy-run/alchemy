---
title: Managing AWS Shield ProtectionGroups with Alchemy
description: Learn how to create, update, and manage AWS Shield ProtectionGroups using Alchemy Cloud Control.
---

# ProtectionGroup

The ProtectionGroup resource lets you create and manage [AWS Shield ProtectionGroups](https://docs.aws.amazon.com/shield/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-shield-protectiongroup.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const protectiongroup = await AWS.Shield.ProtectionGroup("protectiongroup-example", {
  Aggregation: "example-aggregation",
  Pattern: "example-pattern",
  ProtectionGroupId: "example-protectiongroupid",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a protectiongroup with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedProtectionGroup = await AWS.Shield.ProtectionGroup("advanced-protectiongroup", {
  Aggregation: "example-aggregation",
  Pattern: "example-pattern",
  ProtectionGroupId: "example-protectiongroupid",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

