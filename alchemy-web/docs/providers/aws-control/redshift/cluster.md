---
title: Managing AWS Redshift Clusters with Alchemy
description: Learn how to create, update, and manage AWS Redshift Clusters using Alchemy Cloud Control.
---

# Cluster

The Cluster resource lets you create and manage [AWS Redshift Clusters](https://docs.aws.amazon.com/redshift/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-redshift-cluster.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const cluster = await AWS.Redshift.Cluster("cluster-example", {
  NodeType: "example-nodetype",
  MasterUsername: "cluster-masteruser",
  ClusterType: "example-clustertype",
  DBName: "cluster-db",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a cluster with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedCluster = await AWS.Redshift.Cluster("advanced-cluster", {
  NodeType: "example-nodetype",
  MasterUsername: "cluster-masteruser",
  ClusterType: "example-clustertype",
  DBName: "cluster-db",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

