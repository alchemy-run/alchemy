---
title: Managing AWS ElastiCache CacheClusters with Alchemy
description: Learn how to create, update, and manage AWS ElastiCache CacheClusters using Alchemy Cloud Control.
---

# CacheCluster

The CacheCluster resource lets you create and manage [AWS ElastiCache CacheClusters](https://docs.aws.amazon.com/elasticache/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-elasticache-cache-cluster.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const cachecluster = await AWS.ElastiCache.CacheCluster("cachecluster-example", {
  CacheNodeType: "example-cachenodetype",
  Engine: "example-engine",
  NumCacheNodes: 1,
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a cachecluster with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedCacheCluster = await AWS.ElastiCache.CacheCluster("advanced-cachecluster", {
  CacheNodeType: "example-cachenodetype",
  Engine: "example-engine",
  NumCacheNodes: 1,
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

