---
title: Managing AWS EKS Nodegroups with Alchemy
description: Learn how to create, update, and manage AWS EKS Nodegroups using Alchemy Cloud Control.
---

# Nodegroup

The Nodegroup resource lets you create and manage [AWS EKS Nodegroups](https://docs.aws.amazon.com/eks/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-eks-nodegroup.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const nodegroup = await AWS.EKS.Nodegroup("nodegroup-example", {
  NodeRole: "example-noderole",
  Subnets: ["example-subnets-1"],
  ClusterName: "nodegroup-cluster",
  Tags: { Environment: "production", ManagedBy: "Alchemy" },
});
```

## Advanced Configuration

Create a nodegroup with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedNodegroup = await AWS.EKS.Nodegroup("advanced-nodegroup", {
  NodeRole: "example-noderole",
  Subnets: ["example-subnets-1"],
  ClusterName: "nodegroup-cluster",
  Tags: {
    Environment: "production",
    Team: "DevOps",
    Project: "MyApp",
    CostCenter: "Engineering",
    ManagedBy: "Alchemy",
  },
});
```

