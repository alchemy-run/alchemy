---
title: Managing AWS Redshift ClusterSecurityGroups with Alchemy
description: Learn how to create, update, and manage AWS Redshift ClusterSecurityGroups using Alchemy Cloud Control.
---

# ClusterSecurityGroup

The ClusterSecurityGroup resource lets you create and manage [AWS Redshift ClusterSecurityGroups](https://docs.aws.amazon.com/redshift/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-redshift-clustersecuritygroup.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const clustersecuritygroup = await AWS.Redshift.ClusterSecurityGroup(
  "clustersecuritygroup-example",
  {
    Description: "A clustersecuritygroup resource managed by Alchemy",
    Tags: { Environment: "production", ManagedBy: "Alchemy" },
  }
);
```

## Advanced Configuration

Create a clustersecuritygroup with additional configuration:

```ts
import AWS from "alchemy/aws/control";

const advancedClusterSecurityGroup = await AWS.Redshift.ClusterSecurityGroup(
  "advanced-clustersecuritygroup",
  {
    Description: "A clustersecuritygroup resource managed by Alchemy",
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

