---
title: Managing AWS IoT RoleAliass with Alchemy
description: Learn how to create, update, and manage AWS IoT RoleAliass using Alchemy Cloud Control.
---

# RoleAlias

The RoleAlias resource lets you create and manage [AWS IoT RoleAliass](https://docs.aws.amazon.com/iot/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-iot-rolealias.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const rolealias = await AWS.IoT.RoleAlias("rolealias-example", {
  RoleArn: "example-rolearn",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a rolealias with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedRoleAlias = await AWS.IoT.RoleAlias("advanced-rolealias", {
  RoleArn: "example-rolearn",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

