---
title: Managing AWS ElastiCache ParameterGroups with Alchemy
description: Learn how to create, update, and manage AWS ElastiCache ParameterGroups using Alchemy Cloud Control.
---

# ParameterGroup

The ParameterGroup resource lets you create and manage [AWS ElastiCache ParameterGroups](https://docs.aws.amazon.com/elasticache/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-elasticache-parametergroup.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const parametergroup = await AWS.ElastiCache.ParameterGroup("parametergroup-example", {
  Description: "A parametergroup resource managed by Alchemy",
  CacheParameterGroupFamily: "example-cacheparametergroupfamily",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a parametergroup with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedParameterGroup = await AWS.ElastiCache.ParameterGroup("advanced-parametergroup", {
  Description: "A parametergroup resource managed by Alchemy",
  CacheParameterGroupFamily: "example-cacheparametergroupfamily",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

