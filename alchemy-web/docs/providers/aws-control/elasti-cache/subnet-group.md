---
title: Managing AWS ElastiCache SubnetGroups with Alchemy
description: Learn how to create, update, and manage AWS ElastiCache SubnetGroups using Alchemy Cloud Control.
---

# SubnetGroup

The SubnetGroup resource lets you create and manage [AWS ElastiCache SubnetGroups](https://docs.aws.amazon.com/elasticache/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-elasticache-subnetgroup.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const subnetgroup = await AWS.ElastiCache.SubnetGroup("subnetgroup-example", {
  Description: "A subnetgroup resource managed by Alchemy",
  SubnetIds: ["example-subnetids-1"],
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a subnetgroup with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedSubnetGroup = await AWS.ElastiCache.SubnetGroup("advanced-subnetgroup", {
  Description: "A subnetgroup resource managed by Alchemy",
  SubnetIds: ["example-subnetids-1"],
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

