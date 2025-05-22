---
title: Managing AWS DocDBElastic Clusters with Alchemy
description: Learn how to create, update, and manage AWS DocDBElastic Clusters using Alchemy Cloud Control.
---

# Cluster

The Cluster resource lets you create and manage [AWS DocDBElastic Clusters](https://docs.aws.amazon.com/docdbelastic/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-docdbelastic-cluster.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const cluster = await AWS.DocDBElastic.Cluster("cluster-example", {
  AdminUserName: "cluster-adminuser",
  ShardCount: 1,
  ShardCapacity: 1,
  ClusterName: "cluster-cluster",
  AuthType: "example-authtype",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a cluster with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedCluster = await AWS.DocDBElastic.Cluster("advanced-cluster", {
  AdminUserName: "cluster-adminuser",
  ShardCount: 1,
  ShardCapacity: 1,
  ClusterName: "cluster-cluster",
  AuthType: "example-authtype",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

