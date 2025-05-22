---
title: Managing AWS Athena WorkGroups with Alchemy
description: Learn how to create, update, and manage AWS Athena WorkGroups using Alchemy Cloud Control.
---

# WorkGroup

The WorkGroup resource lets you create and manage [AWS Athena WorkGroups](https://docs.aws.amazon.com/athena/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-athena-workgroup.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const workgroup = await AWS.Athena.WorkGroup("workgroup-example", {
  Name: "workgroup-",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A workgroup resource managed by Alchemy",
});
```

## Advanced Configuration

Create a workgroup with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedWorkGroup = await AWS.Athena.WorkGroup("advanced-workgroup", {
  Name: "workgroup-",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A workgroup resource managed by Alchemy",
});
```

