---
title: Managing AWS RedshiftServerless Workgroups with Alchemy
description: Learn how to create, update, and manage AWS RedshiftServerless Workgroups using Alchemy Cloud Control.
---

# Workgroup

The Workgroup resource lets you create and manage [AWS RedshiftServerless Workgroups](https://docs.aws.amazon.com/redshiftserverless/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-redshiftserverless-workgroup.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const workgroup = await AWS.RedshiftServerless.Workgroup("workgroup-example", {
  WorkgroupName: "workgroup-workgroup",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a workgroup with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedWorkgroup = await AWS.RedshiftServerless.Workgroup("advanced-workgroup", {
  WorkgroupName: "workgroup-workgroup",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

