---
title: Managing AWS Organizations ResourcePolicys with Alchemy
description: Learn how to create, update, and manage AWS Organizations ResourcePolicys using Alchemy Cloud Control.
---

# ResourcePolicy

The ResourcePolicy resource lets you create and manage [AWS Organizations ResourcePolicys](https://docs.aws.amazon.com/organizations/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-organizations-resourcepolicy.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const resourcepolicy = await AWS.Organizations.ResourcePolicy("resourcepolicy-example", {
  Content: {},
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a resourcepolicy with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedResourcePolicy = await AWS.Organizations.ResourcePolicy("advanced-resourcepolicy", {
  Content: {},
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

