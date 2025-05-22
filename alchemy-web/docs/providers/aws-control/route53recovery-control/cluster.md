---
title: Managing AWS Route53RecoveryControl Clusters with Alchemy
description: Learn how to create, update, and manage AWS Route53RecoveryControl Clusters using Alchemy Cloud Control.
---

# Cluster

The Cluster resource lets you create and manage [AWS Route53RecoveryControl Clusters](https://docs.aws.amazon.com/route53recoverycontrol/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-route53recoverycontrol-cluster.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const cluster = await AWS.Route53RecoveryControl.Cluster("cluster-example", {
  Name: "cluster-",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a cluster with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedCluster = await AWS.Route53RecoveryControl.Cluster("advanced-cluster", {
  Name: "cluster-",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

