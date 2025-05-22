---
title: Managing AWS DAX Clusters with Alchemy
description: Learn how to create, update, and manage AWS DAX Clusters using Alchemy Cloud Control.
---

# Cluster

The Cluster resource lets you create and manage [AWS DAX Clusters](https://docs.aws.amazon.com/dax/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-dax-cluster.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const cluster = await AWS.DAX.Cluster("cluster-example", {
  ReplicationFactor: 1,
  IAMRoleARN: "example-iamrolearn",
  NodeType: "example-nodetype",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
  Description: "A cluster resource managed by Alchemy",
});
```

## Advanced Configuration

Create a cluster with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedCluster = await AWS.DAX.Cluster("advanced-cluster", {
  ReplicationFactor: 1,
  IAMRoleARN: "example-iamrolearn",
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

