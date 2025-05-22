---
title: Managing AWS RAM Permissions with Alchemy
description: Learn how to create, update, and manage AWS RAM Permissions using Alchemy Cloud Control.
---

# Permission

The Permission resource lets you create and manage [AWS RAM Permissions](https://docs.aws.amazon.com/ram/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ram-permission.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const permission = await AWS.RAM.Permission("permission-example", {
  ResourceType: "example-resourcetype",
  PolicyTemplate: {},
  Name: "permission-",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a permission with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedPermission = await AWS.RAM.Permission("advanced-permission", {
  ResourceType: "example-resourcetype",
  PolicyTemplate: {},
  Name: "permission-",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

