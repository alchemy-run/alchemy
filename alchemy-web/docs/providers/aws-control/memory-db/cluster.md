---
title: Managing AWS MemoryDB Clusters with Alchemy
description: Learn how to create, update, and manage AWS MemoryDB Clusters using Alchemy Cloud Control.
---

# Cluster

The Cluster resource lets you create and manage [AWS MemoryDB Clusters](https://docs.aws.amazon.com/memorydb/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-memorydb-cluster.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const cluster = await AWS.MemoryDB.Cluster("cluster-example", {
  ACLName: "cluster-acl",
  ClusterName: "cluster-cluster",
  NodeType: "example-nodetype",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A cluster resource managed by Alchemy",
});
```

## Advanced Configuration

Create a cluster with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedCluster = await AWS.MemoryDB.Cluster("advanced-cluster", {
  ACLName: "cluster-acl",
  ClusterName: "cluster-cluster",
  NodeType: "example-nodetype",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
  Description: "A cluster resource managed by Alchemy",
});
```

