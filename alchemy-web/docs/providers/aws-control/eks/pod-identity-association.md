---
title: Managing AWS EKS PodIdentityAssociations with Alchemy
description: Learn how to create, update, and manage AWS EKS PodIdentityAssociations using Alchemy Cloud Control.
---

# PodIdentityAssociation

The PodIdentityAssociation resource lets you create and manage [AWS EKS PodIdentityAssociations](https://docs.aws.amazon.com/eks/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-eks-podidentityassociation.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const podidentityassociation = await AWS.EKS.PodIdentityAssociation(
  "podidentityassociation-example",
  {
    ServiceAccount: "example-serviceaccount",
    ClusterName: "podidentityassociation-cluster",
    RoleArn: "example-rolearn",
    Namespace: "podidentityassociation-space",
    Tags: { Environment: "production", ManagedBy: "Alchemy" },
  }
);
```

## Advanced Configuration

Create a podidentityassociation with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedPodIdentityAssociation = await AWS.EKS.PodIdentityAssociation(
  "advanced-podidentityassociation",
  {
    ServiceAccount: "example-serviceaccount",
    ClusterName: "podidentityassociation-cluster",
    RoleArn: "example-rolearn",
    Namespace: "podidentityassociation-space",
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

