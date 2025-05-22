---
title: Managing AWS Logs LogGroups with Alchemy
description: Learn how to create, update, and manage AWS Logs LogGroups using Alchemy Cloud Control.
---

# LogGroup

The LogGroup resource lets you create and manage [AWS Logs LogGroups](https://docs.aws.amazon.com/logs/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-logs-loggroup.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const loggroup = await AWS.Logs.LogGroup("loggroup-example", {
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a loggroup with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedLogGroup = await AWS.Logs.LogGroup("advanced-loggroup", {
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

