---
title: Managing AWS MemoryDB ParameterGroups with Alchemy
description: Learn how to create, update, and manage AWS MemoryDB ParameterGroups using Alchemy Cloud Control.
---

# ParameterGroup

The ParameterGroup resource lets you create and manage [AWS MemoryDB ParameterGroups](https://docs.aws.amazon.com/memorydb/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-memorydb-parametergroup.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const parametergroup = await AWS.MemoryDB.ParameterGroup("parametergroup-example", {
  ParameterGroupName: "parametergroup-parametergroup",
  Family: "example-family",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A parametergroup resource managed by Alchemy",
});
```

## Advanced Configuration

Create a parametergroup with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedParameterGroup = await AWS.MemoryDB.ParameterGroup("advanced-parametergroup", {
  ParameterGroupName: "parametergroup-parametergroup",
  Family: "example-family",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A parametergroup resource managed by Alchemy",
});
```

