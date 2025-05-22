---
title: Managing AWS ElastiCache ReplicationGroups with Alchemy
description: Learn how to create, update, and manage AWS ElastiCache ReplicationGroups using Alchemy Cloud Control.
---

# ReplicationGroup

The ReplicationGroup resource lets you create and manage [AWS ElastiCache ReplicationGroups](https://docs.aws.amazon.com/elasticache/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-elasticache-replicationgroup.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const replicationgroup = await AWS.ElastiCache.ReplicationGroup("replicationgroup-example", {
  ReplicationGroupDescription: "A replicationgroup resource managed by Alchemy",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a replicationgroup with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedReplicationGroup = await AWS.ElastiCache.ReplicationGroup(
  "advanced-replicationgroup",
  {
    ReplicationGroupDescription: "A replicationgroup resource managed by Alchemy",
    Tags: {
      Environment: "production",
      Team: "DevOps",
      Project: "MyApp",
      CostCenter: "Engineering",
      ManagedBy: "Alchemy",
    },
  }
);
```

